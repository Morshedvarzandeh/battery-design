extends SceneTree

# Runs the real viewer script headlessly in CI. Node tests own the two NTNU
# source payloads; this smoke test owns the other side of that boundary: datum
# placement, named picking, malformed-payload refusal and visible provenance.


func _initialize() -> void:
	call_deferred("_run")


func _fail(message: String) -> void:
	push_error("Vessel payload smoke: " + message)
	quit(1)


func _all_label_text(node: Node) -> String:
	var text := ""
	if node is Label:
		text += (node as Label).text + "\n"
	for child in node.get_children():
		text += _all_label_text(child)
	return text


func _run() -> void:
	var packed: PackedScene = load("res://main.tscn")
	if packed == null:
		_fail("main scene did not load")
		return
	var viewer := packed.instantiate()
	root.add_child(viewer)
	await process_frame

	var model := {
		"assetId": "marine/runtime-smoke-vessel",
		"version": "runtime-smoke",
		"category": "marine",
		"scenePreset": "ocean",
		"geometryDigest": "fnv1a32:runtime",
		"licence": {"spdx": "MIT", "origin": "original-code-generated-geometry"},
		"primitives": [
			{
				"kind": "box", "role": "hull", "name": "Runtime hull",
				"sizeM": {"x": 1.0, "y": 2.0, "z": 0.2},
				"atM": {"x": 0.0, "y": 0.0, "z": -0.1}, "tint": "#5f8f96",
				"material": {"color": "#12344a", "roughness": 0.5, "metallic": 0.1, "opacity": 1.0},
			},
			{
				"kind": "mesh", "role": "deck", "name": "Runtime mesh deck",
				"sizeM": {"x": 1.0, "y": 1.0, "z": 0.1},
				"atM": {"x": 0.0, "y": 0.0, "z": 0.05},
				"vertices": [[-0.5,-0.5,-0.05],[0.5,-0.5,-0.05],[0.5,0.5,-0.05],[-0.5,0.5,-0.05],[-0.5,-0.5,0.05],[0.5,-0.5,0.05],[0.5,0.5,0.05],[-0.5,0.5,0.05]],
				"triangles": [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]],
				"material": {"color": "#7e9298", "roughness": 0.7, "metallic": 0.2, "opacity": 1.0},
			},
			{
				"kind": "cylinder", "role": "mast", "name": "Runtime cylinder mast",
				"sizeM": {"x": 0.1, "y": 0.1, "z": 1.0},
				"atM": {"x": 0.0, "y": 0.0, "z": 0.5},
				"radiusM": 0.05, "heightM": 1.0, "axis": "z",
				"material": {"color": "#93a4ab", "roughness": 0.3, "metallic": 0.6, "opacity": 1.0},
			},
			# The malformed primitive is refused rather than becoming pickable.
			{"kind": "sphere", "role": "invented", "name": "Must not render"},
			"not a primitive",
		],
	}
	var host := {
		"name": "Runtime vessel",
		"kind": "runtime-vessel",
		"sizeM": {
			"x": 2.8, "y": 5.0, "z": 3.5,
			"zMin": -0.2, "zMax": 3.3, "waterlineZ": 0.0, "baselineZ": -0.2,
		},
		"mount": {"name": "Indicative study position"},
		"seatM": {"x": 0.0, "y": 0.0, "z": -1.55},
		"dimsFrom": "published-particulars",
		"dimsLabel": "waterline-datum engineering massing envelope; not CAD",
		"model": model,
		"evidence": {"title": "NTNU runtime provenance fixture"},
		"boundary": "Engineering massing only, not CAD or compartment geometry.",
	}

	viewer.call("_build_studio", host, {"x": 100.0, "y": 100.0, "z": 100.0})
	var pickables: Array = viewer.get("_pickables")
	if pickables.size() != 3:
		_fail("three valid portable primitives and two malformed primitives produced %d pickables" % pickables.size())
		return
	var picked: Dictionary = pickables[0]
	if picked.get("name") != "Runtime hull" or picked.get("id") != "vessel:hull:0":
		_fail("valid vessel primitive lost its name or stable viewer id")
		return
	var bounds: AABB = picked.get("aabb")
	if not is_equal_approx(bounds.position.y, 0.0) or not is_equal_approx(bounds.size.y, 0.2):
		_fail("negative-draught primitive was not shifted from waterline coordinates to the display baseline")
		return

	var room: Node = viewer.get("_room")
	var ocean := room.get_node_or_null("WaterPlane") as Node3D
	if ocean == null or not is_equal_approx(ocean.position.y, 0.165):
		_fail("ocean surface is missing or not anchored to the supplied waterline")
		return

	viewer.call("_fill_spec", {
		"pack": {"s": 1, "p": 1, "cellCount": 1, "outer": {"x": 1, "y": 1, "z": 1}},
		"cell": {"chemistry": "fixture", "color": "#ffffff"},
		"parts": [], "host": host,
	})
	await process_frame
	var visible_text := _all_label_text(viewer.get("_spec") as Node)
	for raw_required in [
		"VESSEL MODEL · NOT CAD",
		"design waterline z=0 · z up",
		"NTNU runtime provenance fixture",
		"Engineering massing only, not CAD",
		"marine/runtime-smoke-vessel",
		"MIT · original-code-generated-geometry",
	]:
		var required := str(raw_required)
		if visible_text.find(required) < 0:
			_fail("visible viewer metadata omitted: " + required)
			return

	quit(0)
