#!/usr/bin/env python3
"""Independent FMPy gate plus deterministic sign-convention trajectory evidence."""

from __future__ import annotations

import argparse
import json
import math
import sys
import zipfile
from pathlib import Path

import fmpy
import numpy as np
from fmpy import simulate_fmu
from fmpy.validation import validate_fmu
from lxml import etree

from fmu_host_evidence import (
    SIGNAL_ROLES, build_evidence, invariant, read_archive_contract,
    read_archive_io_contract, require_role, write_evidence,
)


FMI_SCHEMA = (Path(__file__).resolve().parent.parent / "third_party" / "fmi-2.0.5"
              / "schema" / "fmi2ModelDescription.xsd")
OUTPUT_KEYS = (
    "pack_voltage", "state_of_charge", "cell_temperature", "heat_source",
    "cell_voltage", "pack_power",
)


def validate_pinned_schema(artifact: Path) -> None:
    """Validate the packaged XML against the repository's pinned FMI 2.0.5 XSD."""
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    schema = etree.XMLSchema(etree.parse(str(FMI_SCHEMA), parser))
    with zipfile.ZipFile(artifact) as package:
        model_description = etree.fromstring(package.read("modelDescription.xml"), parser)
    schema.assertValid(model_description)


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


def sample(row, names: dict[str, str]) -> dict[str, float]:
    return {SIGNAL_ROLES[key]: float(row[names[key]]) for key in OUTPUT_KEYS}


def checked(
    condition: bool, identifier: str, description: str, observed: dict[str, object]
) -> dict[str, object]:
    if not condition:
        raise RuntimeError(f"FMPy host trajectory invariant failed: {identifier}: {observed}")
    return invariant(identifier, description, observed)


def simulate_constant(
    artifact: Path,
    names: dict[str, str],
    *,
    current: float,
    ambient: float,
    flow: float,
    duration: float,
    output_interval: float = 1.0,
):
    return simulate_fmu(
        str(artifact),
        validate=True,
        start_time=0.0,
        stop_time=duration,
        step_size=min(1.0, output_interval),
        output_interval=output_interval,
        fmi_type="CoSimulation",
        start_values={
            names["pack_current"]: current,
            names["ambient_temperature"]: ambient,
            names["coolant_flow"]: flow,
        },
        output=[names[key] for key in OUTPUT_KEYS],
    )


def validate_result(result, names: dict[str, str], duration: float) -> None:
    expected_names = ("time", *(names[key] for key in OUTPUT_KEYS))
    if len(result) < 2 or result.dtype.names != expected_names:
        raise RuntimeError(f"FMPy returned an unexpected result contract: {result.dtype.names}")
    for row in result:
        if not all(math.isfinite(float(row[name])) for name in result.dtype.names):
            raise RuntimeError("FMPy simulation returned a non-finite value")
    if not math.isclose(float(result[0]["time"]), 0.0, abs_tol=1e-12):
        raise RuntimeError("FMPy trajectory does not start at t=0")
    if not math.isclose(float(result[-1]["time"]), duration, abs_tol=1e-9):
        raise RuntimeError(f"FMPy trajectory does not end at t={duration}")


def validate_constant_electrical_result(
    result, names: dict[str, str], *, current: float, series: float
) -> None:
    for row in result:
        voltage = float(row[names["pack_voltage"]])
        power = float(row[names["pack_power"]])
        cell_voltage = float(row[names["cell_voltage"]])
        if not math.isclose(power, voltage * current, rel_tol=1e-9, abs_tol=1e-7):
            raise RuntimeError("FMPy trajectory violates P_terminal = V_pack * I_pack")
        if not math.isclose(cell_voltage, voltage / series, rel_tol=1e-9, abs_tol=1e-8):
            raise RuntimeError("FMPy trajectory violates the uniform-cell voltage relation")


def electrical_invariants(
    final: dict[str, float], *, current: float, series: float, prefix: str
) -> list[dict[str, object]]:
    voltage = final[SIGNAL_ROLES["pack_voltage"]]
    power = final[SIGNAL_ROLES["pack_power"]]
    cell_voltage = final[SIGNAL_ROLES["cell_voltage"]]
    return [
        checked(
            all(math.isfinite(value) for value in final.values()),
            f"{prefix}.finite_outputs", "All mapped outputs remain finite.", final,
        ),
        checked(
            math.isclose(power, voltage * current, rel_tol=1e-9, abs_tol=1e-7),
            f"{prefix}.terminal_power_identity",
            "Terminal power follows the declared P = V * I polarity.",
            {"currentA": current, "powerW": power, "voltageV": voltage},
        ),
        checked(
            math.isclose(cell_voltage, voltage / series, rel_tol=1e-9, abs_tol=1e-8),
            f"{prefix}.uniform_cell_voltage_identity",
            "The uniform-cell voltage estimate equals pack voltage divided by series count.",
            {"cellVoltageV": cell_voltage, "seriesCount": series, "voltageV": voltage},
        ),
    ]


def run_scenarios(
    artifact: Path, contract: dict[str, object], names: dict[str, str]
) -> list[dict[str, object]]:
    series_variable = require_role(contract, SIGNAL_ROLES["series_count"], causality="parameter")
    series = float(series_variable["start"])
    scenarios: list[dict[str, object]] = []

    idle_result = simulate_constant(
        artifact, names, current=0.0, ambient=25.0, flow=0.05, duration=10.0,
    )
    validate_result(idle_result, names, 10.0)
    validate_constant_electrical_result(idle_result, names, current=0.0, series=series)
    idle_initial = sample(idle_result[0], names)
    idle_final = sample(idle_result[-1], names)
    idle_invariants = electrical_invariants(idle_final, current=0.0, series=series, prefix="idle")
    idle_invariants.extend([
        checked(
            math.isclose(
                idle_final[SIGNAL_ROLES["state_of_charge"]],
                idle_initial[SIGNAL_ROLES["state_of_charge"]], abs_tol=1e-12,
            ),
            "idle.zero_current_preserves_soc", "Zero current preserves state of charge.",
            {
                "final": idle_final[SIGNAL_ROLES["state_of_charge"]],
                "initial": idle_initial[SIGNAL_ROLES["state_of_charge"]],
            },
        ),
        checked(
            math.isclose(idle_final[SIGNAL_ROLES["cell_temperature"]], 25.0, abs_tol=1e-10),
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
        "samples": {"final": idle_final, "initial": idle_initial},
        "verdict": "pass",
    })

    discharge_result = simulate_constant(
        artifact, names, current=100.0, ambient=25.0, flow=0.05, duration=60.0,
    )
    validate_result(discharge_result, names, 60.0)
    validate_constant_electrical_result(discharge_result, names, current=100.0, series=series)
    discharge_initial = sample(discharge_result[0], names)
    discharge_final = sample(discharge_result[-1], names)
    discharge_invariants = electrical_invariants(
        discharge_final, current=100.0, series=series, prefix="discharge",
    )
    discharge_invariants.extend([
        checked(
            0.0 < discharge_final[SIGNAL_ROLES["state_of_charge"]]
            < discharge_initial[SIGNAL_ROLES["state_of_charge"]] <= 1.0,
            "discharge.positive_current_reduces_soc",
            "Positive terminal current is the discharge direction and reduces state of charge.",
            {
                "currentA": 100.0,
                "final": discharge_final[SIGNAL_ROLES["state_of_charge"]],
                "initial": discharge_initial[SIGNAL_ROLES["state_of_charge"]],
            },
        ),
        checked(
            discharge_final[SIGNAL_ROLES["pack_power"]] > 0.0,
            "discharge.positive_power_is_delivered",
            "Positive discharge current produces positive power delivered by the pack.",
            {"powerW": discharge_final[SIGNAL_ROLES["pack_power"]]},
        ),
        checked(
            discharge_final[SIGNAL_ROLES["pack_voltage"]]
            < discharge_initial[SIGNAL_ROLES["pack_voltage"]],
            "discharge.terminal_voltage_decreases",
            "The non-trivial discharge trajectory reduces terminal voltage.",
            {
                "finalV": discharge_final[SIGNAL_ROLES["pack_voltage"]],
                "initialV": discharge_initial[SIGNAL_ROLES["pack_voltage"]],
            },
        ),
        checked(
            discharge_final[SIGNAL_ROLES["cell_temperature"]]
            >= discharge_initial[SIGNAL_ROLES["cell_temperature"]],
            "discharge.lumped_node_does_not_cool",
            "The discharge trajectory does not unexpectedly cool the lumped thermal node.",
            {
                "finalC": discharge_final[SIGNAL_ROLES["cell_temperature"]],
                "initialC": discharge_initial[SIGNAL_ROLES["cell_temperature"]],
            },
        ),
    ])
    scenarios.append({
        "durationS": 60.0,
        "id": "discharge",
        "inputs": role_inputs(contract, {
            "pack_current": 100.0, "ambient_temperature": 25.0, "coolant_flow": 0.05,
        }),
        "invariants": discharge_invariants,
        "samples": {"final": discharge_final, "initial": discharge_initial},
        "verdict": "pass",
    })

    # The model starts at full SoC, so discharge first. FMPy's documented
    # duplicate-time representation creates a discrete current reversal
    # without interpolating the preceding discharge ramp.
    input_dtype = [
        ("time", np.float64),
        (names["pack_current"], np.float64),
        (names["ambient_temperature"], np.float64),
        (names["coolant_flow"], np.float64),
    ]
    charge_input = np.array([
        (0.0, 200.0, 25.0, 0.05),
        (60.0, 200.0, 25.0, 0.05),
        (60.0, -100.0, 25.0, 0.05),
        (120.0, -100.0, 25.0, 0.05),
    ], dtype=input_dtype)
    charge_result = simulate_fmu(
        str(artifact), validate=True, start_time=0.0, stop_time=120.0,
        step_size=1.0, output_interval=1.0, fmi_type="CoSimulation", input=charge_input,
        output=[names[key] for key in OUTPUT_KEYS],
    )
    validate_result(charge_result, names, 120.0)
    precondition_index = min(
        range(len(charge_result)), key=lambda index: abs(float(charge_result[index]["time"]) - 60.0)
    )
    preconditioned = sample(charge_result[precondition_index], names)
    charge_final = sample(charge_result[-1], names)
    charge_invariants = electrical_invariants(
        charge_final, current=-100.0, series=series, prefix="charge",
    )
    charge_invariants.extend([
        checked(
            charge_final[SIGNAL_ROLES["state_of_charge"]]
            > preconditioned[SIGNAL_ROLES["state_of_charge"]],
            "charge.negative_current_increases_soc",
            "After discharge preconditioning, negative terminal current increases state of charge.",
            {
                "currentA": -100.0,
                "final": charge_final[SIGNAL_ROLES["state_of_charge"]],
                "initial": preconditioned[SIGNAL_ROLES["state_of_charge"]],
                "preconditionCurrentA": 200.0,
            },
        ),
        checked(
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
        "samples": {"activeFinal": charge_final, "preconditioned": preconditioned},
        "verdict": "pass",
    })

    thermal_samples: dict[str, dict[str, float]] = {}
    for label, flow in (("noFlow", 0.0), ("activeFlow", 0.2)):
        result = simulate_constant(
            artifact, names, current=400.0, ambient=25.0, flow=flow,
            duration=300.0, output_interval=10.0,
        )
        validate_result(result, names, 300.0)
        validate_constant_electrical_result(result, names, current=400.0, series=series)
        thermal_samples[label] = sample(result[-1], names)
    no_flow_temperature = thermal_samples["noFlow"][SIGNAL_ROLES["cell_temperature"]]
    active_flow_temperature = thermal_samples["activeFlow"][SIGNAL_ROLES["cell_temperature"]]
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
        "invariants": [checked(
            active_flow_temperature < no_flow_temperature,
            "thermal.positive_flow_reduces_temperature",
            "At equal current and ambient, positive coolant flow lowers the final lumped-node temperature.",
            {
                "activeFlowCellTemperatureC": active_flow_temperature,
                "activeFlowKgPerS": 0.2,
                "noFlowCellTemperatureC": no_flow_temperature,
                "noFlowKgPerS": 0.0,
            },
        )],
        "samples": thermal_samples,
        "verdict": "pass",
    })
    return scenarios


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", help="compiled battery-design-ev.fmu")
    parser.add_argument("--evidence-json", type=Path, default=None)
    parser.add_argument("--evidence-csv", type=Path, default=None)
    args = parser.parse_args()
    if (args.evidence_json is None) != (args.evidence_csv is None):
        parser.error("--evidence-json and --evidence-csv must be provided together")
    artifact = Path(args.artifact).resolve()

    validate_pinned_schema(artifact)
    problems = validate_fmu(str(artifact))
    if problems:
        raise RuntimeError("FMPy validation failed:\n" + "\n".join(problems))

    io_contract = read_archive_io_contract(artifact)
    names = signal_names(io_contract)
    scenarios = run_scenarios(artifact, io_contract, names)
    summary: dict[str, object] = {
        "schema": "FMI 2.0.5",
        "scenarios": scenarios,
        "validator": "FMPy",
        "version": fmpy.__version__,
    }
    if args.evidence_json is not None:
        release_contract = read_archive_contract(artifact)
        evidence = build_evidence(
            contract=release_contract,
            host_name="FMPy",
            host_version=fmpy.__version__,
            host_platform=sys.platform,
            scenarios=scenarios,
            roles=list(SIGNAL_ROLES.values()),
        )
        write_evidence(evidence, args.evidence_json.resolve(), args.evidence_csv.resolve())
        summary["evidenceChecksum"] = evidence["evidenceChecksum"]
    print(json.dumps(summary, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
