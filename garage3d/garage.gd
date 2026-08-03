# garage.gd — draw the pack. Compute nothing.
#
# This is the whole rule for this file, and it is worth stating before the
# first line of code: every number that reaches here was produced by the
# design engine in js/. Positions, sizes, wall thickness, which parts are
# fitted, how many cells are in a series group — all of it arrives in the
# scene payload. If something is missing, it gets added to js/scene3d.js and
# sent; it does not get worked out here.
#
# The reason is not purity. It is that a battery designer with two opinions
# about where a cell sits is worse than one with none, and a renderer is
# exactly where a second opinion creeps in — a rounded pitch here, an assumed
# gap there, and the pretty picture stops being the pack the audit is about.
#
# What this file is allowed to decide: camera, lighting, materials, and how a
# click maps to a name. Everything a person could call taste.

extends Node3D

const MM := 0.001                     # the engine speaks millimetres; Godot is happier in metres
const MSG_READY := "bd3d:ready"
const MSG_PICK := "bd3d:pick"
const MSG_ERROR := "bd3d:error"
const SCENE_VERSION := 1

var _camera: Camera3D
var _rig: Node3D                      # yaw
var _boom: Node3D                     # pitch
var _pack_root: Node3D
var _caption: Label
var _hint: Label
var _status: Label

var _orbit_yaw := 0.6
var _orbit_pitch := -0.5
var _distance := 3.0
var _target_distance := 3.0
var _dragging := false
var _pickables: Array = []            # [{aabb: AABB, name: String, category: String}]
var _js_callback                      # kept alive: a freed callback silently stops delivery
var _have_scene := false


func _ready() -> void:
	_build_stage()
	_build_ui()
	_open_the_pipe()
	set_process(true)


# ---------------------------------------------------------------------------
# Stage: camera, lights, ground. None of this describes the pack.
# ---------------------------------------------------------------------------
func _build_stage() -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.055, 0.075, 0.070)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.45, 0.52, 0.50)
	env.ambient_light_energy = 0.55
	var world := WorldEnvironment.new()
	world.environment = env
	add_child(world)

	# A garage is lit from above and from one side. Two lights read as a room;
	# one reads as a product shot, which is the wrong feeling for a workshop.
	var key := DirectionalLight3D.new()
	key.rotation_degrees = Vector3(-55, -40, 0)
	key.light_energy = 1.1
	add_child(key)
	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(-20, 130, 0)
	fill.light_energy = 0.35
	fill.light_color = Color(0.75, 0.85, 0.95)
	add_child(fill)

	_rig = Node3D.new()
	add_child(_rig)
	_boom = Node3D.new()
	_rig.add_child(_boom)
	_camera = Camera3D.new()
	_camera.fov = 42.0
	_camera.near = 0.01
	_camera.far = 200.0
	_boom.add_child(_camera)

	_pack_root = Node3D.new()
	add_child(_pack_root)


func _build_ui() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	var box := VBoxContainer.new()
	box.set_anchors_preset(Control.PRESET_TOP_LEFT)
	box.position = Vector2(16, 12)
	layer.add_child(box)
	_caption = Label.new()
	_caption.add_theme_font_size_override("font_size", 17)
	box.add_child(_caption)
	_status = Label.new()
	_status.add_theme_font_size_override("font_size", 12)
	_status.modulate = Color(1, 1, 1, 0.65)
	box.add_child(_status)

	_hint = Label.new()
	_hint.add_theme_font_size_override("font_size", 12)
	_hint.modulate = Color(1, 1, 1, 0.45)
	_hint.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	_hint.position = Vector2(16, -28)
	_hint.text = "drag to orbit · wheel to zoom · click a part to name it"
	layer.add_child(_hint)

	_caption.text = "waiting for a design…"
	_status.text = ""


# ---------------------------------------------------------------------------
# The pipe. The host posts a scene into the page; the shell hands it here.
# ---------------------------------------------------------------------------
func _open_the_pipe() -> void:
	if not OS.has_feature("web"):
		# Run from the editor with no host: draw something so the scene can be
		# opened and worked on without the whole app around it.
		_render(_demo_scene())
		return
	_js_callback = JavaScriptBridge.create_callback(_on_js_scene)
	var window := JavaScriptBridge.get_interface("window")
	if window == null:
		push_error("no window interface")
		return
	window.bdReceiveScene = _js_callback
	_post({"type": MSG_READY, "v": SCENE_VERSION})


func _on_js_scene(args: Array) -> void:
	if args.is_empty():
		return
	var parsed = JSON.parse_string(str(args[0]))
	if typeof(parsed) != TYPE_DICTIONARY:
		_fail("scene payload was not an object")
		return
	# A version we do not speak is refused rather than half-drawn: a pack drawn
	# from a payload this build does not understand is a picture of nothing.
	var v = parsed.get("v", 0)
	if int(v) != SCENE_VERSION:
		_fail("scene version %s, this build speaks %d" % [str(v), SCENE_VERSION])
		return
	_render(parsed)


func _post(msg: Dictionary) -> void:
	if not OS.has_feature("web"):
		return
	var payload := JSON.stringify(msg).replace("\\", "\\\\").replace("'", "\\'")
	JavaScriptBridge.eval("window.parent && window.parent.postMessage(JSON.parse('%s'), '*')" % payload, true)


func _fail(why: String) -> void:
	_status.text = why
	_post({"type": MSG_ERROR, "v": SCENE_VERSION, "why": why})


# ---------------------------------------------------------------------------
# Rendering — reading the payload, never extending it.
# ---------------------------------------------------------------------------
func _render(scene: Dictionary) -> void:
	for child in _pack_root.get_children():
		child.queue_free()
	_pickables.clear()

	var pack: Dictionary = scene.get("pack", {})
	var cell: Dictionary = scene.get("cell", {})
	var cells: Dictionary = scene.get("cells", {})

	_caption.text = str(scene.get("title", ""))
	var audit: Dictionary = scene.get("audit", {})
	var fails := int(audit.get("fail", 0))
	_status.text = str(scene.get("subtitle", ""))
	if fails > 0:
		# The audit travels with the scene so a failing pack cannot be admired
		# in 3D while the panel that says it fails sits on another tab.
		_status.text += "  ·  %d failing: %s" % [fails, str(audit.get("worst", ""))]
		_status.modulate = Color(0.93, 0.42, 0.36, 0.95)
	else:
		_status.modulate = Color(1, 1, 1, 0.65)

	_add_cells(cell, cells)
	for part in scene.get("parts", []):
		_add_part(part)

	_frame_on(pack)
	_have_scene = true


func _add_cells(cell: Dictionary, cells: Dictionary) -> void:
	var xyz: Array = cells.get("xyz", [])
	var count := int(cells.get("count", 0))
	if count <= 0 or xyz.size() < count * 3:
		return
	var size: Dictionary = cell.get("size", {})
	var mesh: Mesh
	if bool(cell.get("round", false)):
		# The drawn body is inset inside its footprint: the footprint includes
		# the spacing the layout reserved, and drawing to it would weld the
		# whole pack into one solid slab.
		var r := float(size.get("x", 21.0)) * 0.5 - 0.35
		var cyl := CylinderMesh.new()
		cyl.top_radius = r * MM
		cyl.bottom_radius = r * MM
		cyl.height = (float(size.get("z", 70.0)) - 0.6) * MM
		cyl.radial_segments = 20
		cyl.rings = 1
		mesh = cyl
	else:
		var box := BoxMesh.new()
		box.size = Vector3(
			(float(size.get("x", 30.0)) - 0.5) * MM,
			(float(size.get("z", 100.0)) - 0.5) * MM,
			(float(size.get("y", 100.0)) - 0.5) * MM)
		mesh = box

	var mat := StandardMaterial3D.new()
	mat.metallic = 0.35
	mat.roughness = 0.42
	mat.vertex_color_use_as_albedo = true
	mesh.surface_set_material(0, mat)

	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	mm.mesh = mesh
	mm.instance_count = count

	var base := Color(str(cell.get("color", "#6f7b78")))
	var group: Array = cells.get("group", [])
	for i in count:
		# Our engine is z-up (z stacks layers); Godot is y-up. Same swap the
		# 2D and Three.js views make, kept here so the payload never has to
		# know which renderer is reading it.
		var t := Transform3D(Basis(), Vector3(
			float(xyz[i * 3]) * MM,
			float(xyz[i * 3 + 2]) * MM,
			float(xyz[i * 3 + 1]) * MM))
		mm.set_instance_transform(i, t)
		# Series groups banded so the current path reads at a glance — the same
		# reason the 2D view colours them. Brightness is banded and hue is left
		# alone: lerping towards white washed the chemistry colour out until
		# every pack looked like the same grey slab, which threw away the one
		# thing the colour was carrying.
		var g := 0
		if i < group.size():
			g = int(group[i])
		var band := float(g % 6) / 6.0
		var col := base
		col.v = clampf(base.v * (0.62 + band * 0.62), 0.0, 1.0)
		col.s = clampf(base.s * (1.05 - band * 0.25), 0.0, 1.0)
		mm.set_instance_color(i, col)

	var inst := MultiMeshInstance3D.new()
	inst.multimesh = mm
	_pack_root.add_child(inst)


func _add_part(part: Dictionary) -> void:
	var label := str(part.get("name", ""))
	var category := str(part.get("categoryName", part.get("category", "")))
	for shape in part.get("shapes", []):
		var size: Dictionary = shape.get("size", {})
		var at: Dictionary = shape.get("at", {})
		var role := str(shape.get("role", ""))
		var sx := float(size.get("x", 1.0)) * MM
		var sy := float(size.get("z", 1.0)) * MM
		var sz := float(size.get("y", 1.0)) * MM
		var pos := Vector3(
			float(at.get("x", 0.0)) * MM,
			float(at.get("z", 0.0)) * MM,
			float(at.get("y", 0.0)) * MM)

		var box := BoxMesh.new()
		box.size = Vector3(sx, sy, sz)
		var mat := StandardMaterial3D.new()
		match role:
			"cooling":
				mat.albedo_color = Color(0.35, 0.62, 0.85)
				mat.metallic = 0.7
				mat.roughness = 0.3
			"housing":
				# The enclosure is a glass box, not a lid: a solid housing hides
				# the pack, and the pack is the thing worth looking at.
				mat.albedo_color = Color(0.31, 0.82, 0.71, 0.10)
				mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
				mat.cull_mode = BaseMaterial3D.CULL_DISABLED
				mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
			"vent":
				mat.albedo_color = Color(0.85, 0.66, 0.26)
				mat.roughness = 0.6
			_:
				mat.albedo_color = Color(0.55, 0.58, 0.57)
		box.surface_set_material(0, mat)

		var inst := MeshInstance3D.new()
		inst.mesh = box
		inst.position = pos
		_pack_root.add_child(inst)

		if role != "housing":
			_pickables.append({
				"aabb": AABB(pos - Vector3(sx, sy, sz) * 0.5, Vector3(sx, sy, sz)),
				"name": label, "category": category, "id": str(part.get("id", "")),
			})


func _frame_on(pack: Dictionary) -> void:
	var outer: Dictionary = pack.get("outer", {})
	var span: float = maxf(maxf(float(outer.get("x", 200.0)), float(outer.get("y", 200.0))),
			float(outer.get("z", 200.0))) * MM
	_target_distance = max(0.35, span * 1.7)
	_distance = _target_distance


# ---------------------------------------------------------------------------
# Camera and picking.
# ---------------------------------------------------------------------------
func _process(delta: float) -> void:
	_distance = lerp(_distance, _target_distance, clamp(delta * 8.0, 0.0, 1.0))
	_rig.rotation = Vector3(0, _orbit_yaw, 0)
	_boom.rotation = Vector3(_orbit_pitch, 0, 0)
	_camera.position = Vector3(0, 0, _distance)


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_LEFT:
			_dragging = event.pressed
			if not event.pressed:
				_try_pick(event.position)
		elif event.button_index == MOUSE_BUTTON_WHEEL_UP:
			_target_distance = max(0.15, _target_distance * 0.88)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_target_distance = min(80.0, _target_distance * 1.14)
	elif event is InputEventMouseMotion and _dragging:
		_orbit_yaw -= event.relative.x * 0.008
		_orbit_pitch = clamp(_orbit_pitch - event.relative.y * 0.008, -1.45, 1.45)


func _try_pick(at: Vector2) -> void:
	if not _have_scene or _pickables.is_empty():
		return
	var from := _camera.project_ray_origin(at)
	var dir := _camera.project_ray_normal(at)
	var best = null
	var best_t := INF
	for p in _pickables:
		var hit = (p["aabb"] as AABB).intersects_ray(from, dir)
		if hit == null:
			continue
		var t := from.distance_to(hit)
		if t < best_t:
			best_t = t
			best = p
	if best == null:
		return
	_post({
		"type": MSG_PICK, "v": SCENE_VERSION,
		"id": best["id"], "category": best["category"], "name": best["name"],
	})


# A pack to look at when the scene is opened in the editor with no host
# attached. Deliberately tiny and obviously fake — it must never be mistaken
# for a design, so it is four cells and says so.
func _demo_scene() -> Dictionary:
	var xyz: Array = []
	var group: Array = []
	for i in 4:
		xyz.append_array([float(i % 2) * 25.0 - 12.5, floor(i / 2.0) * 25.0 - 12.5, 0.0])
		group.append(i)
	return {
		"v": SCENE_VERSION,
		"title": "no design attached",
		"subtitle": "editor preview — four cells, not a design",
		"pack": {"outer": {"x": 60.0, "y": 60.0, "z": 80.0}},
		"cell": {"round": true, "color": "#4fd1b5", "size": {"x": 21.0, "y": 21.0, "z": 70.0}},
		"cells": {"count": 4, "xyz": xyz, "group": group, "groups": 4},
		"parts": [], "audit": {"fail": 0, "warn": 0},
	}
