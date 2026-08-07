#!/usr/bin/env python3
"""Deterministic, content-bound evidence for FMI host trajectory checks."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree


EVIDENCE_FORMAT = "battery-design/fmi-host-trajectory-evidence@1"
IO_MAP_PATH = "resources/battery-design-io-map.json"
BUILD_MANIFEST_PATH = "resources/battery-design-build.json"
PROPRIETARY_HOST_DISCLAIMER = (
    "Open-source import-and-step evidence; not certification or an acceptance "
    "result from ANSYS Twin Builder, MATLAB/Simulink, or GT-SUITE."
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SOURCE_REVISION_PATTERN = re.compile(r"^[0-9a-f]{40}$")
SIGNAL_ROLES = {
    "ambient_temperature": "battery.environment.ambientTemperature",
    "cell_temperature": "battery.cell.representativeTemperature",
    "cell_voltage": "battery.cell.uniformTerminalVoltageEstimate",
    "coolant_flow": "battery.coolant.massFlow",
    "heat_source": "battery.pack.netInternalHeatSource",
    "pack_current": "battery.pack.terminalCurrent",
    "pack_power": "battery.pack.terminalPower",
    "pack_voltage": "battery.pack.terminalVoltage",
    "series_count": "battery.pack.seriesCount",
    "state_of_charge": "battery.pack.stateOfCharge",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(
        value, allow_nan=False, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    )


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot read {label}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must contain one JSON object")
    return value


def _parse_json_bytes(content: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(content.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot read {label}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must contain one JSON object")
    return value


def _model_identity(content: bytes) -> dict[str, str]:
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as error:
        raise RuntimeError(f"Cannot parse modelDescription.xml: {error}") from error
    co_simulation = root.find("CoSimulation")
    guid = root.attrib.get("guid")
    model_identifier = co_simulation.attrib.get("modelIdentifier") if co_simulation is not None else None
    if not guid or not model_identifier:
        raise RuntimeError("modelDescription.xml has no Co-Simulation GUID/model identifier")
    return {
        "guid": guid,
        "modelIdentifier": model_identifier,
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def read_io_contract(tree: Path) -> dict[str, Any]:
    """Read the canonical packaged role map without requiring release metadata."""
    io_path = tree / IO_MAP_PATH
    io_map = _read_json(io_path, "the packaged FMI I/O map")
    io_checksum = io_map.get("contractChecksum")
    if not isinstance(io_checksum, str) or not SHA256_PATTERN.fullmatch(io_checksum):
        raise RuntimeError("The packaged FMI I/O map has no valid contract checksum")

    variables = io_map.get("variables")
    if not isinstance(variables, list) or not variables:
        raise RuntimeError("The packaged FMI I/O map has no variables")
    by_role: dict[str, dict[str, Any]] = {}
    names: set[str] = set()
    for variable in variables:
        if not isinstance(variable, dict):
            raise RuntimeError("The packaged FMI I/O map contains a non-object variable")
        role = variable.get("role")
        name = variable.get("name")
        if not isinstance(role, str) or not role or role in by_role:
            raise RuntimeError(f"The packaged FMI I/O map has an invalid or duplicate role: {role!r}")
        if not isinstance(name, str) or not name or name in names:
            raise RuntimeError(f"The packaged FMI I/O map has an invalid or duplicate name: {name!r}")
        by_role[role] = variable
        names.add(name)

    model_content = (tree / "modelDescription.xml").read_bytes()
    return {
        "ioMap": io_map,
        "ioMapSha256": sha256_file(io_path),
        "modelDescription": _model_identity(model_content),
        "roles": by_role,
    }


def _bind_artifact_contract(
    contract: dict[str, Any], manifest: dict[str, Any], fmu_sha256: str | None,
    expected_source_revision: str | None,
) -> dict[str, Any]:
    io_map = contract["ioMap"]
    source_revision = manifest.get("sourceRevision")
    if not isinstance(source_revision, str) or not SOURCE_REVISION_PATTERN.fullmatch(source_revision):
        raise RuntimeError(
            "Host evidence requires a packaged FMU bound to one full lowercase source revision"
        )
    if expected_source_revision is not None:
        if not SOURCE_REVISION_PATTERN.fullmatch(expected_source_revision):
            raise RuntimeError("Expected host-evidence source revision must be a full lowercase SHA")
        if source_revision != expected_source_revision:
            raise RuntimeError("FMU manifest source revision does not match the trusted expected revision")
    if manifest.get("artifactKind") != "compiled-fmu":
        raise RuntimeError("Host evidence requires a compiled-fmu build manifest")
    if fmu_sha256 is not None and not SHA256_PATTERN.fullmatch(fmu_sha256):
        raise RuntimeError("Could not establish the FMU archive SHA-256")

    expected = {
        "guid": io_map.get("guid"),
        "modelIdentifier": io_map.get("modelIdentifier"),
        "modelRevision": io_map.get("modelRevision"),
    }
    for field, value in expected.items():
        if not isinstance(value, str) or not value or manifest.get(field) != value:
            raise RuntimeError(f"FMU build manifest and I/O map disagree on {field}")
    model_description = contract.get("modelDescription")
    if (
        not isinstance(model_description, dict)
        or model_description.get("guid") != manifest.get("guid")
        or model_description.get("modelIdentifier") != manifest.get("modelIdentifier")
        or model_description.get("sha256") != manifest.get("modelDescriptionSha256")
    ):
        raise RuntimeError("FMU build manifest is not bound to modelDescription.xml")
    io_checksum = io_map["contractChecksum"]
    manifest_contract = manifest.get("ioContract")
    if (
        not isinstance(manifest_contract, dict)
        or manifest_contract.get("path") != IO_MAP_PATH
        or manifest_contract.get("checksum") != io_checksum
        or manifest_contract.get("sha256") != contract.get("ioMapSha256")
    ):
        raise RuntimeError("FMU build manifest is not bound to the packaged I/O contract")
    if manifest.get("fmiVersion") != io_map.get("fmiVersion"):
        raise RuntimeError("FMU build manifest and I/O map disagree on the FMI version")

    return {
        **contract,
        "artifact": {
            "fmiVersion": manifest["fmiVersion"],
            "fmuSha256": fmu_sha256,
            "guid": manifest["guid"],
            "ioContractChecksum": io_checksum,
            "ioMapSha256": contract["ioMapSha256"],
            "modelIdentifier": manifest["modelIdentifier"],
            "modelRevision": manifest["modelRevision"],
            "sourceRevision": source_revision,
            "sourceRevisionVerification": {
                "basis": "trusted-expected-revision" if expected_source_revision is not None
                else "unverified-manifest-claim",
                "verified": expected_source_revision is not None,
            },
        },
    }


def read_artifact_contract(
    tree: Path, archive: Path | None = None, expected_source_revision: str | None = None,
) -> dict[str, Any]:
    """Read and cross-bind an unpacked manifest, I/O map, and optional archive identity."""
    return _bind_artifact_contract(
        read_io_contract(tree),
        _read_json(tree / BUILD_MANIFEST_PATH, "the packaged FMU build manifest"),
        sha256_file(archive) if archive is not None else None,
        expected_source_revision if expected_source_revision is not None
        else os.environ.get("BATTERY_DESIGN_SOURCE_REVISION"),
    )


def read_archive_contract(
    archive: Path, expected_source_revision: str | None = None,
) -> dict[str, Any]:
    """Read only the fixed contract resources from an FMU without extracting arbitrary paths."""
    with zipfile.ZipFile(archive) as package:
        names = package.namelist()
        if names.count("modelDescription.xml") != 1:
            raise RuntimeError("FMU archive must contain exactly one modelDescription.xml")
        model_info = package.getinfo("modelDescription.xml")
        if model_info.file_size > 4 * 1024 * 1024:
            raise RuntimeError("modelDescription.xml exceeds the 4 MiB read limit")
        model_description = _model_identity(package.read(model_info))
        resources: dict[str, dict[str, Any]] = {}
        resource_bytes: dict[str, bytes] = {}
        for path, label in (
            (IO_MAP_PATH, "the packaged FMI I/O map"),
            (BUILD_MANIFEST_PATH, "the packaged FMU build manifest"),
        ):
            if names.count(path) != 1:
                raise RuntimeError(f"FMU archive must contain exactly one {path}")
            info = package.getinfo(path)
            if info.file_size > 4 * 1024 * 1024:
                raise RuntimeError(f"FMU contract resource exceeds the 4 MiB read limit: {path}")
            resource_bytes[path] = package.read(info)
            resources[path] = _parse_json_bytes(resource_bytes[path], label)
    io_map = resources[IO_MAP_PATH]
    variables = io_map.get("variables")
    if not isinstance(variables, list) or not variables:
        raise RuntimeError("The packaged FMI I/O map has no variables")
    by_role: dict[str, dict[str, Any]] = {}
    names_seen: set[str] = set()
    for variable in variables:
        if not isinstance(variable, dict):
            raise RuntimeError("The packaged FMI I/O map contains a non-object variable")
        role = variable.get("role")
        name = variable.get("name")
        if not isinstance(role, str) or not role or role in by_role:
            raise RuntimeError(f"The packaged FMI I/O map has an invalid or duplicate role: {role!r}")
        if not isinstance(name, str) or not name or name in names_seen:
            raise RuntimeError(f"The packaged FMI I/O map has an invalid or duplicate name: {name!r}")
        by_role[role] = variable
        names_seen.add(name)
    checksum = io_map.get("contractChecksum")
    if not isinstance(checksum, str) or not SHA256_PATTERN.fullmatch(checksum):
        raise RuntimeError("The packaged FMI I/O map has no valid contract checksum")
    return _bind_artifact_contract(
        {
            "ioMap": io_map,
            "ioMapSha256": hashlib.sha256(resource_bytes[IO_MAP_PATH]).hexdigest(),
            "modelDescription": model_description,
            "roles": by_role,
        },
        resources[BUILD_MANIFEST_PATH],
        sha256_file(archive),
        expected_source_revision if expected_source_revision is not None
        else os.environ.get("BATTERY_DESIGN_SOURCE_REVISION"),
    )


def read_archive_io_contract(archive: Path) -> dict[str, Any]:
    """Read only the canonical I/O role map, including from a local unprovenanced package."""
    with zipfile.ZipFile(archive) as package:
        names = package.namelist()
        if names.count(IO_MAP_PATH) != 1:
            raise RuntimeError(f"FMU archive must contain exactly one {IO_MAP_PATH}")
        info = package.getinfo(IO_MAP_PATH)
        if info.file_size > 4 * 1024 * 1024:
            raise RuntimeError(f"FMU contract resource exceeds the 4 MiB read limit: {IO_MAP_PATH}")
        io_content = package.read(info)
        io_map = _parse_json_bytes(io_content, "the packaged FMI I/O map")
    variables = io_map.get("variables")
    checksum = io_map.get("contractChecksum")
    if not isinstance(variables, list) or not variables:
        raise RuntimeError("The packaged FMI I/O map has no variables")
    if not isinstance(checksum, str) or not SHA256_PATTERN.fullmatch(checksum):
        raise RuntimeError("The packaged FMI I/O map has no valid contract checksum")
    by_role: dict[str, dict[str, Any]] = {}
    names_seen: set[str] = set()
    for variable in variables:
        if not isinstance(variable, dict):
            raise RuntimeError("The packaged FMI I/O map contains a non-object variable")
        role = variable.get("role")
        name = variable.get("name")
        if not isinstance(role, str) or not role or role in by_role:
            raise RuntimeError(f"The packaged FMI I/O map has an invalid or duplicate role: {role!r}")
        if not isinstance(name, str) or not name or name in names_seen:
            raise RuntimeError(f"The packaged FMI I/O map has an invalid or duplicate name: {name!r}")
        by_role[role] = variable
        names_seen.add(name)
    return {
        "ioMap": io_map,
        "ioMapSha256": hashlib.sha256(io_content).hexdigest(),
        "roles": by_role,
    }


def require_role(
    contract: dict[str, Any], role: str, *, causality: str | None = None
) -> dict[str, Any]:
    variable = contract["roles"].get(role)
    if variable is None:
        raise RuntimeError(f"The packaged FMI I/O map does not declare required role {role}")
    if causality is not None and variable.get("causality") != causality:
        raise RuntimeError(
            f"The packaged FMI role {role} is not declared with {causality} causality"
        )
    return variable


def role_projection(contract: dict[str, Any], roles: list[str]) -> dict[str, dict[str, Any]]:
    return {
        role: {
            "causality": require_role(contract, role).get("causality"),
            "name": require_role(contract, role).get("name"),
            "unit": require_role(contract, role).get("unit"),
            "valueReference": require_role(contract, role).get("valueReference"),
        }
        for role in sorted(set(roles))
    }


def invariant(identifier: str, description: str, observed: dict[str, Any]) -> dict[str, Any]:
    return {
        "description": description,
        "id": identifier,
        "observed": observed,
        "passed": True,
    }


def build_evidence(
    *,
    contract: dict[str, Any],
    host_name: str,
    host_version: str,
    host_platform: str,
    scenarios: list[dict[str, Any]],
    roles: list[str],
) -> dict[str, Any]:
    if contract["artifact"]["fmuSha256"] is None:
        raise RuntimeError("Structured host evidence requires a packaged .fmu archive")
    if not isinstance(scenarios, list) or not scenarios:
        raise RuntimeError("Structured host evidence requires at least one scenario")
    scenario_ids: set[str] = set()
    for scenario_index, scenario in enumerate(scenarios):
        if not isinstance(scenario, dict):
            raise RuntimeError(
                f"Structured host evidence scenario {scenario_index} must be an object"
            )
        scenario_id = scenario.get("id")
        if not isinstance(scenario_id, str) or not scenario_id.strip():
            raise RuntimeError(
                f"Structured host evidence scenario {scenario_index} requires a non-empty id"
            )
        if scenario_id in scenario_ids:
            raise RuntimeError(
                f"Structured host evidence scenario id {scenario_id!r} is duplicated"
            )
        scenario_ids.add(scenario_id)
        if scenario.get("verdict") != "pass":
            raise RuntimeError(
                f"Structured host evidence scenario {scenario_id!r} did not pass"
            )
        checks = scenario.get("invariants")
        if not isinstance(checks, list) or not checks:
            raise RuntimeError(
                f"Structured host evidence scenario {scenario_id!r} requires at least one invariant"
            )
        invariant_ids: set[str] = set()
        for invariant_index, check in enumerate(checks):
            if not isinstance(check, dict):
                raise RuntimeError(
                    f"Structured host evidence scenario {scenario_id!r} invariant "
                    f"{invariant_index} must be an object"
                )
            invariant_id = check.get("id")
            if not isinstance(invariant_id, str) or not invariant_id.strip():
                raise RuntimeError(
                    f"Structured host evidence scenario {scenario_id!r} invariant "
                    f"{invariant_index} requires a non-empty id"
                )
            if invariant_id in invariant_ids:
                raise RuntimeError(
                    f"Structured host evidence invariant id {invariant_id!r} is duplicated "
                    f"within scenario {scenario_id!r}"
                )
            invariant_ids.add(invariant_id)
            if not isinstance(check.get("description"), str) or not check["description"].strip():
                raise RuntimeError(
                    f"Structured host evidence invariant {invariant_id!r} requires a description"
                )
            if not isinstance(check.get("observed"), dict):
                raise RuntimeError(
                    f"Structured host evidence invariant {invariant_id!r} requires observed values"
                )
            if check.get("passed") is not True:
                raise RuntimeError(
                    f"Structured host evidence invariant {invariant_id!r} did not pass"
                )
    payload = {
        "artifact": contract["artifact"],
        "contractDiscovery": {
            "ioMapPath": IO_MAP_PATH,
            "method": "stable-role lookup from the packaged canonical I/O map",
            "variables": role_projection(contract, roles),
        },
        "format": EVIDENCE_FORMAT,
        "host": {
            "fmiInterface": "CoSimulation",
            "name": host_name,
            "platform": host_platform,
            "version": host_version,
        },
        "scope": PROPRIETARY_HOST_DISCLAIMER,
        "scenarios": scenarios,
        "verdict": "pass",
    }
    evidence_checksum = hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()
    return {**payload, "evidenceChecksum": evidence_checksum}


CSV_FIELDS = (
    "format", "host_name", "host_version", "host_platform", "source_revision",
    "source_revision_verified", "source_revision_verification_basis", "guid",
    "model_identifier", "model_revision", "fmu_sha256", "io_contract_checksum",
    "scenario_id", "scenario_verdict", "invariant_id", "invariant_verdict", "observed_json",
    "evidence_checksum",
)


def write_evidence(evidence: dict[str, Any], json_path: Path, csv_path: Path) -> None:
    json_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    artifact = evidence["artifact"]
    host = evidence["host"]
    with csv_path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        for scenario in evidence["scenarios"]:
            for check in scenario["invariants"]:
                writer.writerow({
                    "format": evidence["format"],
                    "host_name": host["name"],
                    "host_version": host["version"],
                    "host_platform": host["platform"],
                    "source_revision": artifact["sourceRevision"],
                    "source_revision_verified": str(
                        artifact["sourceRevisionVerification"]["verified"]
                    ).lower(),
                    "source_revision_verification_basis": artifact[
                        "sourceRevisionVerification"
                    ]["basis"],
                    "guid": artifact["guid"],
                    "model_identifier": artifact["modelIdentifier"],
                    "model_revision": artifact["modelRevision"],
                    "fmu_sha256": artifact["fmuSha256"],
                    "io_contract_checksum": artifact["ioContractChecksum"],
                    "scenario_id": scenario["id"],
                    "scenario_verdict": scenario["verdict"],
                    "invariant_id": check["id"],
                    "invariant_verdict": "pass" if check["passed"] else "fail",
                    "observed_json": canonical_json(check["observed"]),
                    "evidence_checksum": evidence["evidenceChecksum"],
                })
