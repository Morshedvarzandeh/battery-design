#!/usr/bin/env python3
"""Independent FMPy import-and-step gate for the compiled release FMU."""

from __future__ import annotations

import argparse
import json
import math
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import fmpy
from fmpy import simulate_fmu
from fmpy.validation import validate_fmu
from lxml import etree


OUTPUTS = ("V_pack", "SoC", "T_cell", "Q_loss", "V_cell_min", "P_terminal")
FMI_SCHEMA = (Path(__file__).resolve().parent.parent / "third_party" / "fmi-2.0.5"
              / "schema" / "fmi2ModelDescription.xsd")


def validate_pinned_schema(artifact: Path) -> None:
    """Validate the packaged XML against the repository's pinned FMI 2.0.5 XSD."""
    parser = etree.XMLParser(resolve_entities=False, no_network=True)
    schema = etree.XMLSchema(etree.parse(str(FMI_SCHEMA), parser))
    with zipfile.ZipFile(artifact) as package:
        model_description = etree.fromstring(package.read("modelDescription.xml"), parser)
    schema.assertValid(model_description)


def parameter_start(artifact: Path, name: str) -> float:
    with zipfile.ZipFile(artifact) as package:
        root = ElementTree.fromstring(package.read("modelDescription.xml"))
    variables = root.find("ModelVariables")
    if variables is None:
        raise RuntimeError("modelDescription.xml has no ModelVariables")
    for scalar in variables:
        if scalar.attrib.get("name") == name:
            real = scalar.find("Real")
            if real is None or "start" not in real.attrib:
                break
            return float(real.attrib["start"])
    raise RuntimeError(f"modelDescription.xml has no Real start for {name}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", help="compiled battery-design-ev.fmu")
    args = parser.parse_args()
    artifact = Path(args.artifact).resolve()

    validate_pinned_schema(artifact)
    problems = validate_fmu(str(artifact))
    if problems:
        raise RuntimeError("FMPy validation failed:\n" + "\n".join(problems))

    series = parameter_start(artifact, "cells_series")
    current = 100.0
    result = simulate_fmu(
        str(artifact),
        validate=True,
        start_time=0.0,
        stop_time=1.0,
        step_size=0.1,
        output_interval=0.1,
        fmi_type="CoSimulation",
        start_values={"I_pack": current, "T_ambient": 25.0, "coolant_flow": 0.05},
        output=list(OUTPUTS),
    )
    if len(result) < 2 or result.dtype.names != ("time", *OUTPUTS):
        raise RuntimeError(f"FMPy returned an unexpected result contract: {result.dtype.names}")
    for row in result:
        if not all(math.isfinite(float(row[name])) for name in result.dtype.names):
            raise RuntimeError("FMPy simulation returned a non-finite value")
        if not math.isclose(float(row["P_terminal"]), float(row["V_pack"]) * current,
                            rel_tol=1e-9, abs_tol=1e-7):
            raise RuntimeError("FMPy trajectory violates P_terminal = V_pack * I_pack")
        if not math.isclose(float(row["V_cell_min"]), float(row["V_pack"]) / series,
                            rel_tol=1e-9, abs_tol=1e-8):
            raise RuntimeError("FMPy trajectory violates the uniform-cell voltage relation")

    initial, final = result[0], result[-1]
    if not math.isclose(float(initial["time"]), 0.0, abs_tol=1e-12):
        raise RuntimeError("FMPy trajectory does not start at t=0")
    if not math.isclose(float(final["time"]), 1.0, abs_tol=1e-12):
        raise RuntimeError("FMPy trajectory does not end at t=1")
    if not (0.0 < float(final["SoC"]) < float(initial["SoC"]) <= 1.0):
        raise RuntimeError("Positive discharge did not reduce SoC in FMPy")
    if not float(final["V_pack"]) < float(initial["V_pack"]):
        raise RuntimeError("Positive discharge did not reduce terminal voltage in FMPy")
    if not float(final["T_cell"]) >= float(initial["T_cell"]):
        raise RuntimeError("Positive discharge unexpectedly cooled the lumped node in FMPy")

    print(json.dumps({
        "validator": "FMPy",
        "version": fmpy.__version__,
        "schema": "FMI 2.0.5",
        "samples": len(result),
        "initial": {name: float(initial[name]) for name in result.dtype.names},
        "final": {name: float(final[name]) for name in result.dtype.names},
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
