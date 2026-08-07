#!/usr/bin/env python3
"""Load and exercise a native FMI 2.0 Co-Simulation binary with no dependencies."""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import platform as host_platform
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from fmu_host_evidence import (
    SIGNAL_ROLES, build_evidence, invariant, read_artifact_contract, read_io_contract,
    require_role, write_evidence,
)


FMI2_OK = 0
FMI2_ERROR = 3
FMI2_CO_SIMULATION = 1
FMI2_LAST_SUCCESSFUL_TIME = 2
MAX_ARCHIVE_MEMBERS = 256
MAX_MEMBER_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
REQUIRED_SYMBOLS = (
    "fmi2GetTypesPlatform", "fmi2GetVersion", "fmi2SetDebugLogging",
    "fmi2Instantiate", "fmi2FreeInstance", "fmi2SetupExperiment",
    "fmi2EnterInitializationMode", "fmi2ExitInitializationMode",
    "fmi2Terminate", "fmi2Reset", "fmi2GetReal", "fmi2GetInteger",
    "fmi2GetBoolean", "fmi2GetString", "fmi2SetReal", "fmi2SetInteger",
    "fmi2SetBoolean", "fmi2SetString", "fmi2GetFMUstate", "fmi2SetFMUstate",
    "fmi2FreeFMUstate", "fmi2SerializedFMUstateSize", "fmi2SerializeFMUstate",
    "fmi2DeSerializeFMUstate", "fmi2GetDirectionalDerivative",
    "fmi2SetRealInputDerivatives", "fmi2GetRealOutputDerivatives",
    "fmi2DoStep", "fmi2CancelStep", "fmi2GetStatus", "fmi2GetRealStatus",
    "fmi2GetIntegerStatus", "fmi2GetBooleanStatus", "fmi2GetStringStatus",
)


def default_platform() -> str:
    machine = host_platform.machine().lower()
    if sys.platform.startswith("linux") and machine in {"x86_64", "amd64"}:
        return "linux64"
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "win64"
    if sys.platform == "darwin" and machine in {"x86_64", "amd64"}:
        return "darwin64"
    raise RuntimeError(f"Unsupported native FMI smoke platform: {sys.platform}/{machine}")


def library_suffix(fmi_platform: str) -> str:
    if fmi_platform == "win64":
        return ".dll"
    if fmi_platform == "darwin64":
        return ".dylib"
    if fmi_platform == "linux64":
        return ".so"
    raise RuntimeError(f"Unsupported FMI platform: {fmi_platform}")


def safe_extract(archive: Path, target: Path) -> None:
    if not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise RuntimeError("FMU archive exceeds smoke-test extraction limits")
    total = 0
    with zipfile.ZipFile(archive) as package:
        members = package.infolist()
        if len(members) > MAX_ARCHIVE_MEMBERS:
            raise RuntimeError(f"FMU archive has more than {MAX_ARCHIVE_MEMBERS} members")
        seen: set[str] = set()
        verified: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
        for info in members:
            name = info.filename
            parts = tuple(name.split("/"))
            mode = (info.external_attr >> 16) & 0o170000
            if (
                not name
                or "\\" in name
                or name.startswith("/")
                or info.is_dir()
                or any(part in {"", ".", ".."} or part.startswith(".") for part in parts)
                or "/".join(parts) in seen
                or mode not in {0, 0o100000}
                or info.flag_bits & 0x1
                or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
            ):
                raise RuntimeError(f"Unsafe FMU archive member: {name!r}")
            canonical = "/".join(parts)
            seen.add(canonical)
            total += info.file_size
            if info.file_size > MAX_MEMBER_BYTES or total > MAX_ARCHIVE_BYTES:
                raise RuntimeError("FMU archive exceeds smoke-test extraction limits")
            verified.append((info, parts))

        root = target.resolve()
        for info, parts in verified:
            destination = target.joinpath(*parts).resolve()
            if destination == root or root not in destination.parents:
                raise RuntimeError(f"Unsafe FMU archive member: {info.filename!r}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            copied = 0
            with package.open(info, "r") as source, destination.open("xb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if copied > info.file_size or copied > MAX_MEMBER_BYTES:
                        raise RuntimeError("FMU archive member expanded beyond its declared limit")
                    output.write(chunk)
            if copied != info.file_size:
                raise RuntimeError(f"FMU archive member size mismatch: {info.filename!r}")


LOGGER_CALLBACK = ctypes.CFUNCTYPE(
    None, ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p
)
ALLOCATE_CALLBACK = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t)
FREE_CALLBACK = ctypes.CFUNCTYPE(None, ctypes.c_void_p)
STEP_FINISHED_CALLBACK = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_int)


class Fmi2CallbackFunctions(ctypes.Structure):
    _pack_ = 8
    _fields_ = [
        ("logger", ctypes.c_void_p),
        ("allocateMemory", ctypes.c_void_p),
        ("freeMemory", ctypes.c_void_p),
        ("stepFinished", ctypes.c_void_p),
        ("componentEnvironment", ctypes.c_void_p),
    ]


class NativeFmu:
    def __init__(self, tree: Path, fmi_platform: str):
        xml_path = tree / "modelDescription.xml"
        root = ElementTree.parse(xml_path).getroot()
        if root.attrib.get("fmiVersion") != "2.0":
            raise RuntimeError("Expected an FMI 2.0 modelDescription.xml")
        co_simulation = root.find("CoSimulation")
        if co_simulation is None:
            raise RuntimeError("FMU has no CoSimulation interface")
        self.guid = root.attrib["guid"]
        self.model_identifier = co_simulation.attrib["modelIdentifier"]
        self.variables: dict[str, dict[str, object]] = {}
        model_variables = root.find("ModelVariables")
        if model_variables is None:
            raise RuntimeError("FMU has no ModelVariables")
        for scalar in model_variables:
            real = scalar.find("Real")
            if real is None:
                raise RuntimeError(f"Smoke contract supports scalar Real variables only: {scalar.attrib['name']}")
            self.variables[scalar.attrib["name"]] = {
                "vr": int(scalar.attrib["valueReference"]),
                "causality": scalar.attrib.get("causality", "local"),
                "start": float(real.attrib["start"]) if "start" in real.attrib else None,
            }
        binary = tree / "binaries" / fmi_platform / f"{self.model_identifier}{library_suffix(fmi_platform)}"
        if not binary.is_file() or binary.stat().st_size == 0:
            raise RuntimeError(f"Missing native FMI binary: {binary}")
        self.library = ctypes.CDLL(str(binary))
        for symbol in REQUIRED_SYMBOLS:
            getattr(self.library, symbol)
        self._bind()
        resources = tree / "resources"
        if not resources.is_dir():
            raise RuntimeError(f"FMU resources directory is missing: {resources}")
        self.resource_uri = f"{resources.resolve().as_uri().rstrip('/')}/".encode()
        self._allocations: dict[int, ctypes.Array] = {}
        self.callback_allocations = 0
        self.callback_frees = 0
        self._environment = ctypes.c_uint64(0x42415454455259)

        @LOGGER_CALLBACK
        def logger(_environment, _instance_name, _status, _category, _message):
            return None

        @ALLOCATE_CALLBACK
        def allocate_memory(count, size):
            byte_count = int(count) * int(size)
            if byte_count <= 0 or byte_count > MAX_MEMBER_BYTES:
                return None
            allocation = ctypes.create_string_buffer(byte_count)
            address = ctypes.addressof(allocation)
            self._allocations[address] = allocation
            self.callback_allocations += 1
            return address

        @FREE_CALLBACK
        def free_memory(address):
            if address:
                if self._allocations.pop(int(address), None) is not None:
                    self.callback_frees += 1

        @STEP_FINISHED_CALLBACK
        def step_finished(_environment, _status):
            return None

        self._callback_objects = (logger, allocate_memory, free_memory, step_finished)
        self.callbacks = Fmi2CallbackFunctions(
            ctypes.cast(logger, ctypes.c_void_p).value,
            ctypes.cast(allocate_memory, ctypes.c_void_p).value,
            ctypes.cast(free_memory, ctypes.c_void_p).value,
            ctypes.cast(step_finished, ctypes.c_void_p).value,
            ctypes.addressof(self._environment),
        )

    def _bind(self) -> None:
        lib = self.library
        lib.fmi2GetVersion.argtypes = []
        lib.fmi2GetVersion.restype = ctypes.c_char_p
        lib.fmi2GetTypesPlatform.argtypes = []
        lib.fmi2GetTypesPlatform.restype = ctypes.c_char_p
        lib.fmi2Instantiate.argtypes = [
            ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p,
            ctypes.POINTER(Fmi2CallbackFunctions), ctypes.c_int, ctypes.c_int,
        ]
        lib.fmi2Instantiate.restype = ctypes.c_void_p
        lib.fmi2FreeInstance.argtypes = [ctypes.c_void_p]
        lib.fmi2FreeInstance.restype = None
        lib.fmi2SetupExperiment.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.c_double, ctypes.c_double,
            ctypes.c_int, ctypes.c_double,
        ]
        lib.fmi2SetupExperiment.restype = ctypes.c_int
        lib.fmi2EnterInitializationMode.argtypes = [ctypes.c_void_p]
        lib.fmi2EnterInitializationMode.restype = ctypes.c_int
        lib.fmi2ExitInitializationMode.argtypes = [ctypes.c_void_p]
        lib.fmi2ExitInitializationMode.restype = ctypes.c_int
        lib.fmi2Terminate.argtypes = [ctypes.c_void_p]
        lib.fmi2Terminate.restype = ctypes.c_int
        lib.fmi2Reset.argtypes = [ctypes.c_void_p]
        lib.fmi2Reset.restype = ctypes.c_int
        lib.fmi2GetReal.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint), ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_double),
        ]
        lib.fmi2GetReal.restype = ctypes.c_int
        lib.fmi2SetReal.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint), ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_double),
        ]
        lib.fmi2SetReal.restype = ctypes.c_int
        lib.fmi2DoStep.argtypes = [
            ctypes.c_void_p, ctypes.c_double, ctypes.c_double, ctypes.c_int,
        ]
        lib.fmi2DoStep.restype = ctypes.c_int
        lib.fmi2GetRealStatus.argtypes = [
            ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_double),
        ]
        lib.fmi2GetRealStatus.restype = ctypes.c_int

    def instantiate(self, name: str, guid: str | None = None, fmu_type: int = FMI2_CO_SIMULATION):
        return self.library.fmi2Instantiate(
            name.encode(), fmu_type, (guid or self.guid).encode(), self.resource_uri,
            ctypes.byref(self.callbacks), 0, 0,
        )

    def get(self, component, names: list[str]) -> dict[str, float]:
        references = (ctypes.c_uint * len(names))(*(self.variables[name]["vr"] for name in names))
        values = (ctypes.c_double * len(names))()
        status = self.library.fmi2GetReal(component, references, len(names), values)
        if status != FMI2_OK:
            raise RuntimeError(f"fmi2GetReal failed with status {status}: {names}")
        return dict(zip(names, values))

    def set_status(self, component, values: dict[str, float]) -> int:
        names = list(values)
        references = (ctypes.c_uint * len(names))(*(self.variables[name]["vr"] for name in names))
        data = (ctypes.c_double * len(names))(*(values[name] for name in names))
        return self.library.fmi2SetReal(component, references, len(names), data)

    def set(self, component, values: dict[str, float]) -> None:
        status = self.set_status(component, values)
        if status != FMI2_OK:
            raise RuntimeError(f"fmi2SetReal failed with status {status}: {list(values)}")

    def initialize(self, component, stop_time: float = 10.0) -> None:
        calls: list[int] = []
        for call in (
            lambda: self.library.fmi2SetupExperiment(component, 0, 0.0, 0.0, 1, stop_time),
            lambda: self.library.fmi2EnterInitializationMode(component),
            lambda: self.library.fmi2ExitInitializationMode(component),
        ):
            status = call()
            calls.append(status)
            if status != FMI2_OK:
                raise RuntimeError(f"FMI initialization failed: {tuple(calls)}")


def close_enough(actual: float, expected: float, tolerance: float = 1e-10) -> bool:
    return math.isclose(actual, expected, rel_tol=tolerance, abs_tol=tolerance)


def signal_names(contract: dict[str, object]) -> dict[str, str]:
    expected_causality = {
        "ambient_temperature": "input",
        "cell_temperature": "output",
        "cell_voltage": "output",
        "coolant_flow": "input",
        "heat_source": "output",
        "pack_current": "input",
        "pack_power": "output",
        "pack_voltage": "output",
        "series_count": "parameter",
        "state_of_charge": "output",
    }
    return {
        key: str(require_role(contract, role, causality=expected_causality[key])["name"])
        for key, role in SIGNAL_ROLES.items()
    }


def role_inputs(contract: dict[str, object], values: dict[str, float]) -> dict[str, dict[str, object]]:
    return {
        SIGNAL_ROLES[key]: {
            "unit": require_role(contract, SIGNAL_ROLES[key])["unit"],
            "value": value,
        }
        for key, value in values.items()
    }


def role_sample(
    fmu: NativeFmu, component, names: dict[str, str], keys: tuple[str, ...]
) -> dict[str, float]:
    by_name = fmu.get(component, [names[key] for key in keys])
    return {SIGNAL_ROLES[key]: float(by_name[names[key]]) for key in keys}


def checked_invariant(
    condition: bool, identifier: str, description: str, observed: dict[str, object]
) -> dict[str, object]:
    if not condition:
        raise RuntimeError(f"Host trajectory invariant failed: {identifier}: {observed}")
    return invariant(identifier, description, observed)


def step_component(fmu: NativeFmu, component, start: float, duration: float, step: float = 1.0) -> None:
    time = start
    end = start + duration
    while time < end - 1e-12:
        interval = min(step, end - time)
        status = fmu.library.fmi2DoStep(component, time, interval, 1)
        if status != FMI2_OK:
            raise RuntimeError(f"Host trajectory step failed with status {status} at t={time}")
        time += interval


def run_host_contract_scenarios(
    fmu: NativeFmu, contract: dict[str, object]
) -> list[dict[str, object]]:
    """Prove signed electrical behavior and the reduced thermal boundary by stable role."""
    names = signal_names(contract)
    sample_keys = (
        "pack_voltage", "state_of_charge", "cell_temperature", "heat_source",
        "cell_voltage", "pack_power",
    )
    series = float(fmu.variables[names["series_count"]]["start"])

    def electrical_checks(
        final: dict[str, float], current: float, prefix: str
    ) -> list[dict[str, object]]:
        voltage = final[SIGNAL_ROLES["pack_voltage"]]
        power = final[SIGNAL_ROLES["pack_power"]]
        cell_voltage = final[SIGNAL_ROLES["cell_voltage"]]
        return [
            checked_invariant(
                all(math.isfinite(value) for value in final.values()),
                f"{prefix}.finite_outputs", "All mapped outputs remain finite.", final,
            ),
            checked_invariant(
                close_enough(power, voltage * current, 1e-8),
                f"{prefix}.terminal_power_identity",
                "Terminal power follows the declared P = V * I polarity.",
                {"currentA": current, "powerW": power, "voltageV": voltage},
            ),
            checked_invariant(
                close_enough(cell_voltage, voltage / series, 1e-8),
                f"{prefix}.uniform_cell_voltage_identity",
                "The uniform-cell voltage estimate equals pack voltage divided by series count.",
                {"cellVoltageV": cell_voltage, "seriesCount": series, "voltageV": voltage},
            ),
        ]

    scenarios: list[dict[str, object]] = []

    idle = fmu.instantiate("contract-idle")
    if not idle:
        raise RuntimeError("Could not instantiate idle host-contract scenario")
    try:
        idle_values = {
            names["pack_current"]: 0.0,
            names["ambient_temperature"]: 25.0,
            names["coolant_flow"]: 0.05,
        }
        fmu.set(idle, idle_values)
        fmu.initialize(idle, stop_time=10.0)
        idle_start = role_sample(fmu, idle, names, sample_keys)
        step_component(fmu, idle, 0.0, 10.0)
        idle_final = role_sample(fmu, idle, names, sample_keys)
        idle_invariants = electrical_checks(idle_final, 0.0, "idle")
        idle_invariants.extend([
            checked_invariant(
                close_enough(idle_final[SIGNAL_ROLES["state_of_charge"]],
                             idle_start[SIGNAL_ROLES["state_of_charge"]], 1e-12),
                "idle.zero_current_preserves_soc", "Zero current preserves state of charge.",
                {
                    "final": idle_final[SIGNAL_ROLES["state_of_charge"]],
                    "initial": idle_start[SIGNAL_ROLES["state_of_charge"]],
                },
            ),
            checked_invariant(
                close_enough(idle_final[SIGNAL_ROLES["cell_temperature"]], 25.0, 1e-10),
                "idle.thermal_equilibrium",
                "The idle lumped node remains at its ambient boundary temperature.",
                {"ambientC": 25.0, "cellTemperatureC": idle_final[SIGNAL_ROLES["cell_temperature"]]},
            ),
        ])
        scenarios.append({
            "durationS": 10.0,
            "id": "idle",
            "inputs": role_inputs(contract, {
                "pack_current": 0.0, "ambient_temperature": 25.0, "coolant_flow": 0.05,
            }),
            "invariants": idle_invariants,
            "samples": {"final": idle_final, "initial": idle_start},
            "verdict": "pass",
        })
    finally:
        fmu.library.fmi2FreeInstance(idle)

    discharge = fmu.instantiate("contract-discharge")
    if not discharge:
        raise RuntimeError("Could not instantiate discharge host-contract scenario")
    try:
        discharge_values = {
            names["pack_current"]: 100.0,
            names["ambient_temperature"]: 25.0,
            names["coolant_flow"]: 0.05,
        }
        fmu.set(discharge, discharge_values)
        fmu.initialize(discharge, stop_time=60.0)
        discharge_start = role_sample(fmu, discharge, names, sample_keys)
        step_component(fmu, discharge, 0.0, 60.0)
        discharge_final = role_sample(fmu, discharge, names, sample_keys)
        discharge_invariants = electrical_checks(discharge_final, 100.0, "discharge")
        discharge_invariants.extend([
            checked_invariant(
                discharge_final[SIGNAL_ROLES["state_of_charge"]]
                < discharge_start[SIGNAL_ROLES["state_of_charge"]],
                "discharge.positive_current_reduces_soc",
                "Positive terminal current is the discharge direction and reduces state of charge.",
                {
                    "currentA": 100.0,
                    "final": discharge_final[SIGNAL_ROLES["state_of_charge"]],
                    "initial": discharge_start[SIGNAL_ROLES["state_of_charge"]],
                },
            ),
            checked_invariant(
                discharge_final[SIGNAL_ROLES["pack_power"]] > 0.0,
                "discharge.positive_power_is_delivered",
                "Positive discharge current produces positive power delivered by the pack.",
                {"powerW": discharge_final[SIGNAL_ROLES["pack_power"]]},
            ),
        ])
        scenarios.append({
            "durationS": 60.0,
            "id": "discharge",
            "inputs": role_inputs(contract, {
                "pack_current": 100.0, "ambient_temperature": 25.0, "coolant_flow": 0.05,
            }),
            "invariants": discharge_invariants,
            "samples": {"final": discharge_final, "initial": discharge_start},
            "verdict": "pass",
        })
    finally:
        fmu.library.fmi2FreeInstance(discharge)

    charge = fmu.instantiate("contract-charge")
    if not charge:
        raise RuntimeError("Could not instantiate charge host-contract scenario")
    try:
        fmu.set(charge, {
            names["pack_current"]: 200.0,
            names["ambient_temperature"]: 25.0,
            names["coolant_flow"]: 0.05,
        })
        fmu.initialize(charge, stop_time=120.0)
        step_component(fmu, charge, 0.0, 60.0)
        preconditioned = role_sample(fmu, charge, names, sample_keys)
        fmu.set(charge, {names["pack_current"]: -100.0})
        charge_start = role_sample(fmu, charge, names, sample_keys)
        step_component(fmu, charge, 60.0, 60.0)
        charge_final = role_sample(fmu, charge, names, sample_keys)
        charge_invariants = electrical_checks(charge_final, -100.0, "charge")
        charge_invariants.extend([
            checked_invariant(
                charge_final[SIGNAL_ROLES["state_of_charge"]]
                > charge_start[SIGNAL_ROLES["state_of_charge"]],
                "charge.negative_current_increases_soc",
                "After discharge preconditioning, negative terminal current increases state of charge.",
                {
                    "currentA": -100.0,
                    "final": charge_final[SIGNAL_ROLES["state_of_charge"]],
                    "initial": charge_start[SIGNAL_ROLES["state_of_charge"]],
                    "preconditionCurrentA": 200.0,
                },
            ),
            checked_invariant(
                charge_final[SIGNAL_ROLES["pack_power"]] < 0.0,
                "charge.negative_power_is_absorbed",
                "Negative charge current produces negative terminal power absorbed by the pack.",
                {"powerW": charge_final[SIGNAL_ROLES["pack_power"]]},
            ),
        ])
        scenarios.append({
            "durationS": 120.0,
            "id": "charge-after-discharge-preconditioning",
            "inputs": {
                "active": role_inputs(contract, {
                    "pack_current": -100.0, "ambient_temperature": 25.0, "coolant_flow": 0.05,
                }),
                "precondition": role_inputs(contract, {"pack_current": 200.0}),
            },
            "invariants": charge_invariants,
            "samples": {
                "activeFinal": charge_final,
                "activeInitial": charge_start,
                "preconditioned": preconditioned,
            },
            "verdict": "pass",
        })
    finally:
        fmu.library.fmi2FreeInstance(charge)

    thermal_results: dict[str, dict[str, float]] = {}
    for label, flow in (("noFlow", 0.0), ("activeFlow", 0.2)):
        component = fmu.instantiate(f"contract-thermal-{label}")
        if not component:
            raise RuntimeError(f"Could not instantiate {label} thermal scenario")
        try:
            fmu.set(component, {
                names["pack_current"]: 400.0,
                names["ambient_temperature"]: 25.0,
                names["coolant_flow"]: flow,
            })
            fmu.initialize(component, stop_time=300.0)
            step_component(fmu, component, 0.0, 300.0)
            thermal_results[label] = role_sample(fmu, component, names, sample_keys)
        finally:
            fmu.library.fmi2FreeInstance(component)
    no_flow_temperature = thermal_results["noFlow"][SIGNAL_ROLES["cell_temperature"]]
    active_flow_temperature = thermal_results["activeFlow"][SIGNAL_ROLES["cell_temperature"]]
    thermal_invariants = [
        checked_invariant(
            active_flow_temperature < no_flow_temperature,
            "thermal.positive_flow_reduces_temperature",
            "At equal current and ambient, positive coolant flow lowers the final lumped-node temperature.",
            {
                "activeFlowCellTemperatureC": active_flow_temperature,
                "activeFlowKgPerS": 0.2,
                "noFlowCellTemperatureC": no_flow_temperature,
                "noFlowKgPerS": 0.0,
            },
        ),
    ]
    scenarios.append({
        "durationS": 300.0,
        "id": "thermal-coolant-boundary",
        "inputs": {
            "common": role_inputs(contract, {"pack_current": 400.0, "ambient_temperature": 25.0}),
            "variants": {
                "activeFlow": role_inputs(contract, {"coolant_flow": 0.2}),
                "noFlow": role_inputs(contract, {"coolant_flow": 0.0}),
            },
        },
        "invariants": thermal_invariants,
        "samples": thermal_results,
        "verdict": "pass",
    })
    return scenarios


def exercise(tree: Path, fmi_platform: str) -> dict[str, object]:
    fmu = NativeFmu(tree, fmi_platform)
    io_contract = read_io_contract(tree)
    mapped_names = signal_names(io_contract)
    for key, name in mapped_names.items():
        if name not in fmu.variables:
            raise RuntimeError(f"Mapped FMI role {SIGNAL_ROLES[key]} is absent from modelDescription.xml")
        mapped = require_role(io_contract, SIGNAL_ROLES[key])
        observed = fmu.variables[name]
        if (observed["vr"] != mapped.get("valueReference")
                or observed["causality"] != mapped.get("causality")):
            raise RuntimeError(
                f"Mapped FMI role {SIGNAL_ROLES[key]} disagrees with modelDescription.xml"
            )
    if fmu.library.fmi2GetVersion() != b"2.0" or fmu.library.fmi2GetTypesPlatform() != b"default":
        raise RuntimeError("FMI version/platform inquiry returned the wrong ABI contract")
    rejected = fmu.instantiate("wrong-guid", guid="{00000000-0000-0000-0000-000000000000}")
    if rejected:
        fmu.library.fmi2FreeInstance(rejected)
        raise RuntimeError("FMU accepted a mismatched GUID")
    rejected = fmu.instantiate("wrong-type", fmu_type=0)
    if rejected:
        fmu.library.fmi2FreeInstance(rejected)
        raise RuntimeError("Co-Simulation-only FMU accepted Model Exchange instantiation")

    first = None
    second = None
    try:
        first = fmu.instantiate("battery-a")
        second = fmu.instantiate("battery-b")
        if not first or not second:
            raise RuntimeError("FMU failed to create two simultaneous instances")
        start_names = [
            name for name, variable in fmu.variables.items()
            if variable["causality"] in {"parameter", "input"} and variable["start"] is not None
        ]
        binary_starts = fmu.get(first, start_names)
        for name in start_names:
            expected = float(fmu.variables[name]["start"])
            if not close_enough(binary_starts[name], expected):
                raise RuntimeError(f"XML/binary start mismatch for {name}: {expected} != {binary_starts[name]}")

        alternate_starts = {
            "cells_series": binary_starts["cells_series"] + 1.0,
            "cells_parallel": binary_starts["cells_parallel"] + 1.0,
            "capacity_Ah": binary_starts["capacity_Ah"] * 0.9,
            "ocv_min": binary_starts["ocv_min"] * 0.95,
            "ocv_max": binary_starts["ocv_max"] * 1.01,
            "r0_mOhm": binary_starts["r0_mOhm"] + 1.0,
            "rc1_mOhm": binary_starts["rc1_mOhm"] + 1.0,
            "rc1_tau_s": binary_starts["rc1_tau_s"] * 1.1,
            "r0_Ea_J": binary_starts["r0_Ea_J"] + 100.0,
            "cp_cell": binary_starts["cp_cell"] * 1.01,
            "mass_cell_kg": binary_starts["mass_cell_kg"] * 1.02,
            "h_cool_WK": binary_starts["h_cool_WK"] + 1.0,
            "ua_amb_WK": binary_starts["ua_amb_WK"] + 1.0,
            "entropy_VK": binary_starts["entropy_VK"] + 0.00001,
            "I_pack": 17.0,
            "T_ambient": 31.0,
            "coolant_flow": 0.07,
        }
        fmu.set(first, alternate_starts)
        changed_starts = fmu.get(first, start_names)
        for name, expected in alternate_starts.items():
            if not close_enough(changed_starts[name], expected):
                raise RuntimeError(f"FMU did not apply alternate start {name}")
        if fmu.library.fmi2Reset(first) != FMI2_OK:
            raise RuntimeError("fmi2Reset failed before initialization")
        restored_starts = fmu.get(first, start_names)
        for name in start_names:
            if not close_enough(restored_starts[name], binary_starts[name]):
                raise RuntimeError(f"Reset did not restore compiled start {name}")

        fmu.initialize(first)
        fmu.initialize(second)
        output_names = [
            mapped_names[key] for key in (
                "pack_voltage", "state_of_charge", "cell_temperature", "heat_source",
                "cell_voltage", "pack_power",
            )
        ]
        initial = fmu.get(first, output_names)
        expected_ocv = binary_starts[mapped_names["series_count"]] * binary_starts["ocv_max"]
        if (not close_enough(initial[mapped_names["pack_voltage"]], expected_ocv)
                or not close_enough(initial[mapped_names["state_of_charge"]], 1.0)):
            raise RuntimeError(f"Unexpected initialized outputs: {initial}")

        fmu.set(first, {
            mapped_names["pack_current"]: 100.0,
            mapped_names["ambient_temperature"]: 25.0,
            mapped_names["coolant_flow"]: 0.05,
        })
        time = 0.0
        for _ in range(10):
            status = fmu.library.fmi2DoStep(first, time, 0.1, 1)
            if status != FMI2_OK:
                raise RuntimeError(f"fmi2DoStep failed with status {status} at t={time}")
            time += 0.1
        last_successful_time = ctypes.c_double()
        status = fmu.library.fmi2GetRealStatus(
            first, FMI2_LAST_SUCCESSFUL_TIME, ctypes.byref(last_successful_time)
        )
        if status != FMI2_OK or not close_enough(last_successful_time.value, time):
            raise RuntimeError("fmi2GetRealStatus did not report the last successful communication time")
        discharged = fmu.get(first, output_names)
        untouched = fmu.get(second, output_names)
        if not all(math.isfinite(value) for value in discharged.values()):
            raise RuntimeError(f"FMU produced non-finite outputs: {discharged}")
        if not (
            0.0 < discharged[mapped_names["state_of_charge"]]
            < initial[mapped_names["state_of_charge"]]
            and discharged[mapped_names["pack_voltage"]] < initial[mapped_names["pack_voltage"]]
        ):
            raise RuntimeError(f"Positive discharge did not reduce SoC and voltage: {discharged}")
        if not close_enough(
            discharged[mapped_names["pack_power"]],
            discharged[mapped_names["pack_voltage"]] * 100.0, 1e-8,
        ):
            raise RuntimeError("P_terminal != V_pack * I_pack")
        if not close_enough(
            discharged[mapped_names["cell_voltage"]],
            discharged[mapped_names["pack_voltage"]] / binary_starts[mapped_names["series_count"]],
            1e-8,
        ):
            raise RuntimeError("V_cell_min != V_pack / cells_series")
        if not close_enough(untouched[mapped_names["state_of_charge"]], 1.0):
            raise RuntimeError("Two FMU instances share mutable state")

        if fmu.library.fmi2Reset(first) != FMI2_OK:
            raise RuntimeError("fmi2Reset failed")
        reset_starts = fmu.get(first, start_names)
        for name in start_names:
            expected = float(fmu.variables[name]["start"])
            if not close_enough(reset_starts[name], expected):
                raise RuntimeError(f"Reset did not restore {name}: {reset_starts[name]} != {expected}")
        fmu.initialize(first)
        reset_outputs = fmu.get(first, output_names)
        for name in output_names:
            if not close_enough(reset_outputs[name], untouched[name], 1e-8):
                raise RuntimeError(f"Reset did not restore output {name}: {reset_outputs[name]} != {untouched[name]}")

        if fmu.library.fmi2Terminate(first) != FMI2_OK:
            raise RuntimeError("fmi2Terminate failed")
        if fmu.library.fmi2Reset(first) != FMI2_OK:
            raise RuntimeError("terminate-to-reset transition failed")
        fmu.initialize(first)
        if fmu.library.fmi2DoStep(first, 0.0, 0.1, 1) != FMI2_OK:
            raise RuntimeError("reset instance could not reinitialize and step")
        if fmu.library.fmi2Terminate(first) != FMI2_OK or fmu.library.fmi2Terminate(second) != FMI2_OK:
            raise RuntimeError("fmi2Terminate failed")
    finally:
        if first:
            fmu.library.fmi2FreeInstance(first)
        if second:
            fmu.library.fmi2FreeInstance(second)

    def expect_step_error(name: str, current: float, step: float, stop_time: float = 10.0) -> None:
        component = fmu.instantiate(name)
        if not component:
            raise RuntimeError(f"Could not instantiate negative-case component {name}")
        try:
            fmu.initialize(component, stop_time=stop_time)
            if fmu.library.fmi2DoStep(component, current, step, 1) != FMI2_ERROR:
                raise RuntimeError(f"FMU accepted invalid step case {name}")
            # fmi2Error moves this instance to the error state. Free it now;
            # never issue a second model call on the same component.
        finally:
            fmu.library.fmi2FreeInstance(component)

    expect_step_error("zero-step", 0.0, 0.0)
    expect_step_error("wrong-time", 1.0, 0.1)
    expect_step_error("over-max-step", 0.0, 3600.0001, stop_time=7200.0)

    stopper = fmu.instantiate("stop-time")
    if not stopper:
        raise RuntimeError("Could not instantiate stop-time component")
    try:
        fmu.initialize(stopper, stop_time=0.2)
        if fmu.library.fmi2DoStep(stopper, 0.0, 0.1, 1) != FMI2_OK:
            raise RuntimeError("FMU rejected a step before stop time")
        if fmu.library.fmi2DoStep(stopper, 0.1, 0.1, 1) != FMI2_OK:
            raise RuntimeError("FMU rejected a step ending exactly at stop time")
        if fmu.library.fmi2DoStep(stopper, 0.2, 0.1, 1) != FMI2_ERROR:
            raise RuntimeError("FMU stepped beyond its declared stop time")
    finally:
        fmu.library.fmi2FreeInstance(stopper)

    maximum = fmu.instantiate("maximum-step")
    if not maximum:
        raise RuntimeError("Could not instantiate maximum-step component")
    try:
        fmu.initialize(maximum, stop_time=3600.0)
        if fmu.library.fmi2DoStep(maximum, 0.0, 3600.0, 1) != FMI2_OK:
            raise RuntimeError("FMU rejected its documented maximum communication step")
        if fmu.library.fmi2Terminate(maximum) != FMI2_OK:
            raise RuntimeError("Maximum-step component did not terminate")
    finally:
        fmu.library.fmi2FreeInstance(maximum)

    unknown_component = fmu.instantiate("unknown-vr")
    if not unknown_component:
        raise RuntimeError("Could not instantiate unknown-VR component")
    try:
        unknown = (ctypes.c_uint * 1)(999999)
        unknown_value = (ctypes.c_double * 1)()
        if fmu.library.fmi2GetReal(unknown_component, unknown, 1, unknown_value) != FMI2_ERROR:
            raise RuntimeError("FMU accepted an unknown value reference")
    finally:
        fmu.library.fmi2FreeInstance(unknown_component)

    nonfinite_component = fmu.instantiate("nonfinite-input")
    if not nonfinite_component:
        raise RuntimeError("Could not instantiate nonfinite-input component")
    try:
        if fmu.set_status(nonfinite_component, {mapped_names["pack_current"]: math.nan}) != FMI2_ERROR:
            raise RuntimeError("FMU accepted a non-finite input")
    finally:
        fmu.library.fmi2FreeInstance(nonfinite_component)

    scenarios = run_host_contract_scenarios(fmu, io_contract)

    if fmu._allocations or fmu.callback_allocations == 0 or fmu.callback_allocations != fmu.callback_frees:
        raise RuntimeError("FMU did not balance host callback allocations and frees")

    return {
        "modelIdentifier": fmu.model_identifier,
        "guid": fmu.guid,
        "platform": fmi_platform,
        "ioContractChecksum": io_contract["ioMap"]["contractChecksum"],
        "contractStartsChecked": len(start_names),
        "steps": 10,
        "initial": initial,
        "discharged": discharged,
        "scenarios": scenarios,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", help="unpacked FMU tree or .fmu archive")
    parser.add_argument("--platform", dest="fmi_platform", default=None)
    parser.add_argument("--evidence-json", type=Path, default=None)
    parser.add_argument("--evidence-csv", type=Path, default=None)
    args = parser.parse_args()
    if (args.evidence_json is None) != (args.evidence_csv is None):
        parser.error("--evidence-json and --evidence-csv must be provided together")
    artifact = Path(args.artifact).resolve()
    fmi_platform = args.fmi_platform or default_platform()
    if artifact.is_dir():
        if args.evidence_json is not None:
            parser.error("structured host evidence requires a packaged .fmu archive")
        result = exercise(artifact, fmi_platform)
    else:
        with tempfile.TemporaryDirectory(prefix="battery-design-fmu-smoke-") as directory:
            safe_extract(artifact, Path(directory))
            tree = Path(directory)
            result = exercise(tree, fmi_platform)
            if args.evidence_json is not None:
                contract = read_artifact_contract(tree, artifact)
                evidence = build_evidence(
                    contract=contract,
                    host_name="battery-design native ctypes lifecycle host",
                    host_version="1",
                    host_platform=fmi_platform,
                    scenarios=result["scenarios"],
                    roles=list(SIGNAL_ROLES.values()),
                )
                write_evidence(evidence, args.evidence_json.resolve(), args.evidence_csv.resolve())
                result["evidenceChecksum"] = evidence["evidenceChecksum"]
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
