use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const REQUIRED_VERSION_DEFINE: &str = "#define SUNDIALS_VERSION \"7.8.0\"";
const REQUIRED_MAJOR_DEFINE: &str = "#define SUNDIALS_VERSION_MAJOR 7";
const REQUIRED_MINOR_DEFINE: &str = "#define SUNDIALS_VERSION_MINOR 8";
const REQUIRED_PATCH_DEFINE: &str = "#define SUNDIALS_VERSION_PATCH 0";
const EXPECTED_SOURCE_LOCK: &[u8] = include_bytes!("../native-backends/sundials/source-lock.json");
const EXPECTED_SUITESPARSE_SOURCE_LOCK: &[u8] =
    include_bytes!("../native-backends/suitesparse/source-lock.json");
const INSTALLED_SOURCE_LOCK: &str = "battery-design-sundials-source-lock.json";
const INSTALLED_SUITESPARSE_SOURCE_LOCK: &str = "battery-design-suitesparse-source-lock.json";
const INSTALLED_BUILD_RECEIPT: &str = "battery-design-sundials-build.json";
const INSTALLED_KLU_BUILD_RECEIPT: &str = "battery-design-native-dae-klu-build.json";
const REQUIRED_SOURCE_SHA256: &str =
    "fceb9704259952d371877e8f9c2e2758c4a51751907ad5ab13e38c2bcf140c9d";
const REQUIRED_TAG_OBJECT_SHA: &str = "ac6903fe8d21cad8ba51b61c81c31d230c353ddf";
const REQUIRED_COMMIT_SHA: &str = "aedc088437064dd55b35c000145f7f5db6ee49e3";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../native-backends/sundials/source-lock.json");
    println!("cargo:rerun-if-changed=../native-backends/suitesparse/source-lock.json");
    println!("cargo:rerun-if-env-changed=DAE_SUNDIALS_ROOT");
    println!("cargo:rerun-if-env-changed=SUNDIALS_IDA_KLU_ROOT");

    if env::var_os("CARGO_FEATURE_SUNDIALS_IDA").is_none() {
        return;
    }

    require_linux_native_target();
    require_unwind_panics();

    if env::var_os("CARGO_FEATURE_SUNDIALS_IDA_KLU").is_some() {
        configure_klu_backend();
        return;
    }

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

const KLU_ARCHIVES: [&str; 8] = [
    "libamd.a",
    "libbtf.a",
    "libcolamd.a",
    "libklu.a",
    "libsuitesparseconfig.a",
    "libsundials_core.a",
    "libsundials_ida.a",
    "libsundials_sunlinsolklu.a",
];

const KLU_HEADERS: [&str; 11] = [
    "include/sundials/sundials_config.h",
    "include/ida/ida.h",
    "include/ida/ida_ls.h",
    "include/nvector/nvector_serial.h",
    "include/sunlinsol/sunlinsol_klu.h",
    "include/sunmatrix/sunmatrix_sparse.h",
    "include/suitesparse/SuiteSparse_config.h",
    "include/suitesparse/amd.h",
    "include/suitesparse/btf.h",
    "include/suitesparse/colamd.h",
    "include/suitesparse/klu.h",
];

const KLU_LICENSES: [&str; 9] = [
    "share/licenses/sundials/LICENSE",
    "share/licenses/sundials/NOTICE",
    "share/licenses/suitesparse/AMD.txt",
    "share/licenses/suitesparse/BTF.txt",
    "share/licenses/suitesparse/BTF-LGPL-2.1.txt",
    "share/licenses/suitesparse/COLAMD.txt",
    "share/licenses/suitesparse/KLU.txt",
    "share/licenses/suitesparse/KLU-LGPL-2.1.txt",
    "share/licenses/suitesparse/SuiteSparse_config.txt",
];

fn configure_klu_backend() {
    let root = env::var_os("SUNDIALS_IDA_KLU_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            panic!(
                "feature `sundials-ida-klu` requires SUNDIALS_IDA_KLU_ROOT to name the exact closed @2 SUNDIALS 7.8.0 + SuiteSparse 7.7.0/KLU 2.3.3 static install"
            )
        });
    let metadata = fs::symlink_metadata(&root)
        .unwrap_or_else(|error| panic!("cannot inspect KLU root {}: {error}", root.display()));
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        panic!("KLU root {} must be a real directory", root.display());
    }

    require_installed_lock(
        &root,
        INSTALLED_SOURCE_LOCK,
        EXPECTED_SOURCE_LOCK,
        "SUNDIALS",
    );
    require_installed_lock(
        &root,
        INSTALLED_SUITESPARSE_SOURCE_LOCK,
        EXPECTED_SUITESPARSE_SOURCE_LOCK,
        "SuiteSparse",
    );
    for relative in KLU_HEADERS.into_iter().chain(KLU_LICENSES) {
        require_regular_file(&root.join(relative), relative);
    }

    let library_dir = root.join("lib");
    let mut entries = fs::read_dir(&library_dir)
        .unwrap_or_else(|error| panic!("cannot inspect {}: {error}", library_dir.display()))
        .map(|entry| {
            entry.unwrap_or_else(|error| {
                panic!(
                    "cannot inspect an entry under {}: {error}",
                    library_dir.display()
                )
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    let actual = entries
        .iter()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if actual != KLU_ARCHIVES {
        panic!(
            "{} must contain the exact closed @2 archive surface {:?}; received {:?}",
            library_dir.display(),
            KLU_ARCHIVES,
            actual
        );
    }
    for entry in entries {
        require_regular_file(&entry.path(), "curated static archive");
        if entry
            .metadata()
            .unwrap_or_else(|error| panic!("cannot inspect {}: {error}", entry.path().display()))
            .len()
            == 0
        {
            panic!("curated archive {} is empty", entry.path().display());
        }
    }

    require_klu_header_contract(&root);
    require_klu_build_receipt(&root);

    println!("cargo:rustc-link-search=native={}", library_dir.display());
    println!("cargo:rustc-link-arg=-Wl,--start-group");
    for library in [
        "sundials_ida",
        "sundials_sunlinsolklu",
        "sundials_core",
        "klu",
        "amd",
        "colamd",
        "btf",
        "suitesparseconfig",
    ] {
        println!("cargo:rustc-link-lib=static={library}");
    }
    println!("cargo:rustc-link-arg=-Wl,--end-group");
    println!("cargo:rustc-link-lib=dylib=m");
}

fn require_regular_file(path: &Path, label: &str) {
    println!("cargo:rerun-if-changed={}", path.display());
    let metadata = fs::symlink_metadata(path)
        .unwrap_or_else(|error| panic!("cannot inspect {label} {}: {error}", path.display()));
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        panic!(
            "{label} {} must be a regular non-symlink file",
            path.display()
        );
    }
}

fn require_installed_lock(root: &Path, name: &str, expected: &[u8], label: &str) {
    let path = root.join(name);
    require_regular_file(&path, "installed source lock");
    let actual = fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read {} source lock {}: {error}",
            label,
            path.display()
        )
    });
    if actual != expected {
        panic!(
            "{} source lock {} does not exactly match the repository lock",
            label,
            path.display()
        );
    }
}

fn require_klu_header_contract(root: &Path) {
    let config_path = root.join("include/sundials/sundials_config.h");
    let config = fs::read_to_string(&config_path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", config_path.display()));
    for (name, value) in [
        ("SUNDIALS_VERSION", Some("\"7.8.0\"")),
        ("SUNDIALS_VERSION_MAJOR", Some("7")),
        ("SUNDIALS_VERSION_MINOR", Some("8")),
        ("SUNDIALS_VERSION_PATCH", Some("0")),
        ("SUNDIALS_DOUBLE_PRECISION", Some("1")),
        ("SUNDIALS_INT64_T", Some("1")),
        ("SUNDIALS_MPI_ENABLED", Some("0")),
        ("SUNDIALS_ENABLE_ERROR_CHECKS", None),
        ("SUNDIALS_KLU_ENABLED", None),
    ] {
        require_header_define(&config, &config_path, name, value);
    }

    for (relative, definitions) in [
        (
            "include/suitesparse/SuiteSparse_config.h",
            &[
                ("SUITESPARSE_MAIN_VERSION", "7"),
                ("SUITESPARSE_SUB_VERSION", "7"),
                ("SUITESPARSE_SUBSUB_VERSION", "0"),
            ][..],
        ),
        (
            "include/suitesparse/amd.h",
            &[
                ("AMD_MAIN_VERSION", "3"),
                ("AMD_SUB_VERSION", "3"),
                ("AMD_SUBSUB_VERSION", "2"),
            ][..],
        ),
        (
            "include/suitesparse/btf.h",
            &[
                ("BTF_MAIN_VERSION", "2"),
                ("BTF_SUB_VERSION", "3"),
                ("BTF_SUBSUB_VERSION", "2"),
            ][..],
        ),
        (
            "include/suitesparse/colamd.h",
            &[
                ("COLAMD_MAIN_VERSION", "3"),
                ("COLAMD_SUB_VERSION", "3"),
                ("COLAMD_SUBSUB_VERSION", "3"),
            ][..],
        ),
        (
            "include/suitesparse/klu.h",
            &[
                ("KLU_MAIN_VERSION", "2"),
                ("KLU_SUB_VERSION", "3"),
                ("KLU_SUBSUB_VERSION", "3"),
            ][..],
        ),
    ] {
        let path = root.join(relative);
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
        for (name, value) in definitions {
            require_header_define(&text, &path, name, Some(value));
        }
    }
}

fn require_header_define(text: &str, path: &Path, name: &str, value: Option<&str>) {
    let found = text.lines().any(|line| {
        let mut fields = line.split_whitespace();
        if fields.next() != Some("#define") || fields.next() != Some(name) {
            return false;
        }
        match value {
            Some(expected) => fields.next() == Some(expected),
            None => true,
        }
    });
    if !found {
        panic!(
            "{} does not define {}{}",
            path.display(),
            name,
            value
                .map(|value| format!(" as {value}"))
                .unwrap_or_default()
        );
    }
}

fn require_klu_build_receipt(root: &Path) {
    let receipt_path = root.join(INSTALLED_KLU_BUILD_RECEIPT);
    require_regular_file(&receipt_path, "closed @2 KLU build receipt");
    let receipt = fs::read_to_string(&receipt_path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", receipt_path.display()));
    let toolchain = [
        ("cmake", json_string(&receipt, "cmake", &receipt_path)),
        (
            "cCompiler",
            json_string(&receipt, "cCompiler", &receipt_path),
        ),
        (
            "cxxCompiler",
            json_string(&receipt, "cxxCompiler", &receipt_path),
        ),
        ("archiver", json_string(&receipt, "archiver", &receipt_path)),
        ("linker", json_string(&receipt, "linker", &receipt_path)),
    ];
    if toolchain.iter().any(|(_, value)| value.is_empty()) {
        panic!(
            "{} contains an empty toolchain identity",
            receipt_path.display()
        );
    }

    let artifact_entries = canonical_hash_entries(root, "lib", &KLU_ARCHIVES);
    let header_entries = canonical_hash_entries(root, "", &KLU_HEADERS);
    let license_entries = canonical_hash_entries(root, "", &KLU_LICENSES);
    let sundials_lock_sha = sha256(&root.join(INSTALLED_SOURCE_LOCK));
    let suitesparse_lock_sha = sha256(&root.join(INSTALLED_SUITESPARSE_SOURCE_LOCK));
    let expected = format!(
        concat!(
            "{{\n",
            "  \"format\": \"battery-design/native-dae-klu-build-receipt@2\",\n",
            "  \"backend\": \"SUNDIALS/IDA+SuiteSparse/KLU\",\n",
            "  \"sources\": {{\n",
            "    \"sundials\": {{\n",
            "      \"lockFormat\": \"battery-design/sundials-source-lock@1\",\n",
            "      \"lockSha256\": \"{}\",\n",
            "      \"version\": \"7.8.0\",\n",
            "      \"commitSha\": \"{}\",\n",
            "      \"archiveSha256\": \"{}\"\n",
            "    }},\n",
            "    \"suitesparse\": {{\n",
            "      \"lockFormat\": \"battery-design/suitesparse-source-lock@1\",\n",
            "      \"lockSha256\": \"{}\",\n",
            "      \"version\": \"7.7.0\",\n",
            "      \"commitSha\": \"13806726cbf470914d012d132a85aea1aff9ee77\",\n",
            "      \"archiveSha256\": \"529b067f5d80981f45ddf6766627b8fc5af619822f068f342aab776e683df4f3\"\n",
            "    }}\n",
            "  }},\n",
            "  \"build\": {{\n",
            "    \"linkage\": \"static\",\n",
            "    \"precision\": \"double\",\n",
            "    \"indexBits\": 64,\n",
            "    \"mpi\": false,\n",
            "    \"openmp\": false,\n",
            "    \"klu\": true,\n",
            "    \"kluChecks\": true,\n",
            "    \"cholmod\": false,\n",
            "    \"blas\": false\n",
            "  }},\n",
            "  \"components\": {{\n",
            "    \"SuiteSparse_config\": \"7.7.0\",\n",
            "    \"AMD\": \"3.3.2\",\n",
            "    \"BTF\": \"2.3.2\",\n",
            "    \"COLAMD\": \"3.3.3\",\n",
            "    \"KLU\": \"2.3.3\"\n",
            "  }},\n",
            "  \"artifacts\": {{\n{}\n  }},\n",
            "  \"headers\": {{\n{}\n  }},\n",
            "  \"licenses\": {{\n{}\n  }},\n",
            "  \"toolchain\": {{\n",
            "    \"cmake\": \"{}\",\n",
            "    \"cCompiler\": \"{}\",\n",
            "    \"cxxCompiler\": \"{}\",\n",
            "    \"archiver\": \"{}\",\n",
            "    \"linker\": \"{}\"\n",
            "  }}\n",
            "}}\n"
        ),
        sundials_lock_sha,
        REQUIRED_COMMIT_SHA,
        REQUIRED_SOURCE_SHA256,
        suitesparse_lock_sha,
        artifact_entries,
        header_entries,
        license_entries,
        toolchain[0].1,
        toolchain[1].1,
        toolchain[2].1,
        toolchain[3].1,
        toolchain[4].1,
    );
    if receipt != expected {
        panic!(
            "{} is not the exact canonical closed @2 KLU receipt for this install",
            receipt_path.display()
        );
    }
}

fn canonical_hash_entries(root: &Path, prefix: &str, names: &[&str]) -> String {
    names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let path = if prefix.is_empty() {
                root.join(name)
            } else {
                root.join(prefix).join(name)
            };
            let comma = if index + 1 == names.len() { "" } else { "," };
            format!("    \"{name}\": \"{}\"{comma}", sha256(&path))
        })
        .collect::<Vec<_>>()
        .join("\n")
}
