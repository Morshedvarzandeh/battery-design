use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const REQUIRED_VERSION_DEFINE: &str = "#define SUNDIALS_VERSION \"7.8.0\"";
const REQUIRED_MAJOR_DEFINE: &str = "#define SUNDIALS_VERSION_MAJOR 7";
const REQUIRED_MINOR_DEFINE: &str = "#define SUNDIALS_VERSION_MINOR 8";
const REQUIRED_PATCH_DEFINE: &str = "#define SUNDIALS_VERSION_PATCH 0";
const EXPECTED_SOURCE_LOCK: &[u8] = include_bytes!("../native-backends/sundials/source-lock.json");
const INSTALLED_SOURCE_LOCK: &str = "battery-design-sundials-source-lock.json";
const INSTALLED_BUILD_RECEIPT: &str = "battery-design-sundials-build.json";
const REQUIRED_SOURCE_SHA256: &str =
    "fceb9704259952d371877e8f9c2e2758c4a51751907ad5ab13e38c2bcf140c9d";
const REQUIRED_TAG_OBJECT_SHA: &str = "ac6903fe8d21cad8ba51b61c81c31d230c353ddf";
const REQUIRED_COMMIT_SHA: &str = "aedc088437064dd55b35c000145f7f5db6ee49e3";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../native-backends/sundials/source-lock.json");
    println!("cargo:rerun-if-env-changed=DAE_SUNDIALS_ROOT");

    if env::var_os("CARGO_FEATURE_SUNDIALS_IDA").is_none() {
        return;
    }

    require_linux_native_target();
    require_unwind_panics();

    let root = env::var_os("DAE_SUNDIALS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            panic!(
                "feature `sundials-ida` requires DAE_SUNDIALS_ROOT to name the exact pinned SUNDIALS 7.8.0 static install"
            )
    });
    let include = root.join("include");
    require_exact_source_lock(&root);
    let config_path = include.join("sundials/sundials_config.h");
    println!("cargo:rerun-if-changed={}", config_path.display());
    let config = fs::read_to_string(&config_path).unwrap_or_else(|error| {
        panic!(
            "cannot read pinned SUNDIALS configuration {}: {error}",
            config_path.display()
        )
    });
    require_build_contract(&config, &config_path);

    let library_dir = find_library_dir(&root);
    require_exact_install_surface(&root, &library_dir);
    require_build_receipt(&root, &library_dir);
    reject_klu_archive(&root);

    println!("cargo:rustc-link-search=native={}", library_dir.display());
    // The pinned static IDA archive embeds the serial NVector, dense matrix,
    // dense linear solver, and Newton nonlinear solver objects. Its only
    // external SUNDIALS archive dependency is sundials_core.
    println!("cargo:rustc-link-lib=static=sundials_ida");
    println!("cargo:rustc-link-lib=static=sundials_core");
    println!("cargo:rustc-link-lib=dylib=m");
}

fn require_exact_source_lock(root: &Path) {
    let installed_path = root.join(INSTALLED_SOURCE_LOCK);
    println!("cargo:rerun-if-changed={}", installed_path.display());
    let installed = fs::read(&installed_path).unwrap_or_else(|error| {
        panic!(
            "cannot read pinned SUNDIALS source lock {}: {error}",
            installed_path.display()
        )
    });
    if installed != EXPECTED_SOURCE_LOCK {
        panic!(
            "{} does not exactly match the repository SUNDIALS source lock; refusing to link unverified native archives",
            installed_path.display()
        );
    }
}

fn require_exact_install_surface(root: &Path, library_dir: &Path) {
    for relative in [
        "include/ida/ida.h",
        "include/ida/ida_ls.h",
        "include/nvector/nvector_serial.h",
        "include/sunmatrix/sunmatrix_dense.h",
        "include/sunlinsol/sunlinsol_dense.h",
        "share/licenses/sundials/LICENSE",
        "share/licenses/sundials/NOTICE",
    ] {
        let path = root.join(relative);
        if !path.is_file() {
            panic!("pinned native solver install is missing {}", path.display());
        }
    }
    let mut archives = fs::read_dir(library_dir)
        .unwrap_or_else(|error| panic!("cannot inspect {}: {error}", library_dir.display()))
        .map(|entry| {
            entry.unwrap_or_else(|error| {
                panic!(
                    "cannot inspect an entry under {}: {error}",
                    library_dir.display()
                )
            })
        })
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("a"))
        .collect::<Vec<_>>();
    archives.sort();
    let expected = vec![
        library_dir.join("libsundials_core.a"),
        library_dir.join("libsundials_ida.a"),
    ];
    if archives != expected {
        panic!(
            "{} must contain exactly libsundials_core.a and libsundials_ida.a; received {:?}",
            library_dir.display(),
            archives
        );
    }
}

fn require_build_receipt(root: &Path, library_dir: &Path) {
    let receipt_path = root.join(INSTALLED_BUILD_RECEIPT);
    let receipt = fs::read_to_string(&receipt_path).unwrap_or_else(|error| {
        panic!(
            "cannot read pinned SUNDIALS build receipt {}: {error}",
            receipt_path.display()
        )
    });
    println!("cargo:rerun-if-changed={}", receipt_path.display());
    for path in [
        library_dir.join("libsundials_ida.a"),
        library_dir.join("libsundials_core.a"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let installed_lock = root.join(INSTALLED_SOURCE_LOCK);
    let source_lock_sha256 = sha256(&installed_lock);
    let ida_archive_sha256 = sha256(&library_dir.join("libsundials_ida.a"));
    let core_archive_sha256 = sha256(&library_dir.join("libsundials_core.a"));
    let cmake = json_string(&receipt, "cmake", &receipt_path);
    let c_compiler = json_string(&receipt, "cCompiler", &receipt_path);
    if cmake.is_empty() || c_compiler.is_empty() {
        panic!(
            "{} contains an empty toolchain identity",
            receipt_path.display()
        );
    }

    // The helper emits one canonical receipt representation. Reconstructing
    // that representation closes the schema at every nesting level and also
    // rejects duplicate keys, unknown fields, alternative literal spellings,
    // escapes, and trailing data. Substring checks alone would let an attacker
    // retain all required fields while appending an ungoverned one.
    let expected = format!(
        concat!(
            "{{\n",
            "  \"format\": \"battery-design/sundials-build-receipt@1\",\n",
            "  \"sourceLockFormat\": \"battery-design/sundials-source-lock@1\",\n",
            "  \"sourceLockSha256\": \"{}\",\n",
            "  \"solver\": \"SUNDIALS\",\n",
            "  \"version\": \"7.8.0\",\n",
            "  \"backend\": \"IDA\",\n",
            "  \"releaseTag\": \"v7.8.0\",\n",
            "  \"tagObjectSha\": \"{}\",\n",
            "  \"commitSha\": \"{}\",\n",
            "  \"sourceSizeBytes\": 5022403,\n",
            "  \"sourceSha256\": \"{}\",\n",
            "  \"build\": {{\n",
            "    \"linkage\": \"static\",\n",
            "    \"precision\": \"double\",\n",
            "    \"indexBits\": 64,\n",
            "    \"mpi\": false,\n",
            "    \"klu\": false,\n",
            "    \"errorChecks\": true\n",
            "  }},\n",
            "  \"artifacts\": {{\n",
            "    \"idaArchiveSha256\": \"{}\",\n",
            "    \"coreArchiveSha256\": \"{}\"\n",
            "  }},\n",
            "  \"toolchain\": {{\n",
            "    \"cmake\": \"{}\",\n",
            "    \"cCompiler\": \"{}\"\n",
            "  }}\n",
            "}}\n"
        ),
        source_lock_sha256,
        REQUIRED_TAG_OBJECT_SHA,
        REQUIRED_COMMIT_SHA,
        REQUIRED_SOURCE_SHA256,
        ida_archive_sha256,
        core_archive_sha256,
        cmake,
        c_compiler,
    );
    if receipt != expected {
        panic!(
            "{} is not the exact closed canonical SUNDIALS build receipt",
            receipt_path.display()
        );
    }
}

fn json_string<'a>(receipt: &'a str, key: &str, path: &Path) -> &'a str {
    let marker = format!("\"{key}\": \"");
    let mut matches = receipt.match_indices(&marker);
    let Some((start, _)) = matches.next() else {
        panic!("{} is missing string key `{key}`", path.display());
    };
    if matches.next().is_some() {
        panic!("{} repeats string key `{key}`", path.display());
    }
    let value_start = start + marker.len();
    let remaining = &receipt[value_start..];
    let Some(value_end) = remaining.find('"') else {
        panic!("{} has an unterminated string key `{key}`", path.display());
    };
    let value = &remaining[..value_end];
    if value.contains('\\') || value.chars().any(char::is_control) {
        panic!(
            "{} uses an unsupported escape or control character in `{key}`",
            path.display()
        );
    }
    value
}

fn sha256(path: &Path) -> String {
    let output = Command::new("sha256sum")
        .arg("--")
        .arg(path)
        .output()
        .unwrap_or_else(|error| panic!("cannot hash {}: {error}", path.display()));
    if !output.status.success() {
        panic!("sha256sum failed for {}", path.display());
    }
    let stdout = String::from_utf8(output.stdout)
        .unwrap_or_else(|_| panic!("sha256sum returned non-UTF-8 output for {}", path.display()));
    let digest = stdout.split_whitespace().next().unwrap_or_default();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        panic!(
            "sha256sum returned an invalid digest for {}",
            path.display()
        );
    }
    digest.to_ascii_lowercase()
}

fn require_linux_native_target() {
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let family = env::var("CARGO_CFG_TARGET_FAMILY").unwrap_or_default();
    if os != "linux" || family != "unix" {
        panic!(
            "feature `sundials-ida` is qualified only for a native Linux target; received target OS `{os}` and family `{family}`"
        );
    }
}

fn require_unwind_panics() {
    let strategy = env::var("CARGO_CFG_PANIC").unwrap_or_default();
    if strategy != "unwind" {
        panic!(
            "feature `sundials-ida` requires panic=unwind so future Rust callbacks can contain panics; received `{strategy}`"
        );
    }
}

fn require_build_contract(config: &str, path: &Path) {
    for required in [
        REQUIRED_VERSION_DEFINE,
        REQUIRED_MAJOR_DEFINE,
        REQUIRED_MINOR_DEFINE,
        REQUIRED_PATCH_DEFINE,
        "#define SUNDIALS_DOUBLE_PRECISION 1",
        "#define SUNDIALS_INT64_T 1",
        "#define SUNDIALS_MPI_ENABLED 0",
        "#define SUNDIALS_ENABLE_ERROR_CHECKS",
    ] {
        if !config.lines().any(|line| line.trim() == required) {
            panic!(
                "{} does not satisfy required build contract `{required}`",
                path.display()
            );
        }
    }
    if config
        .lines()
        .any(|line| line.trim() == "#define SUNDIALS_KLU_ENABLED")
    {
        panic!(
            "{} enables KLU, but Iteration 2 is dense/serial only",
            path.display()
        );
    }
}

fn find_library_dir(root: &Path) -> PathBuf {
    for candidate in [root.join("lib"), root.join("lib64")] {
        if candidate.join("libsundials_ida.a").is_file()
            && candidate.join("libsundials_core.a").is_file()
        {
            println!(
                "cargo:rerun-if-changed={}",
                candidate.join("libsundials_ida.a").display()
            );
            println!(
                "cargo:rerun-if-changed={}",
                candidate.join("libsundials_core.a").display()
            );
            return candidate;
        }
    }
    panic!(
        "{} does not contain the required static libsundials_ida.a and libsundials_core.a in lib/ or lib64/",
        root.display()
    );
}

fn reject_klu_archive(root: &Path) {
    for directory in [root.join("lib"), root.join("lib64")] {
        if !directory.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&directory)
            .unwrap_or_else(|error| panic!("cannot inspect {}: {error}", directory.display()));
        for entry in entries {
            let entry = entry.unwrap_or_else(|error| {
                panic!(
                    "cannot inspect an entry under {}: {error}",
                    directory.display()
                )
            });
            let name = entry.file_name();
            if name.to_string_lossy().to_ascii_lowercase().contains("klu") {
                panic!(
                    "{} contains KLU artifact {}; Iteration 2 accepts only the pinned dense/serial install",
                    directory.display(),
                    name.to_string_lossy()
                );
            }
        }
    }
}
