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
var _room: Node3D                     # floor, walls, bench, scale reference
var _bench_top := 0.0                 # where the pack is set down, metres
var _scale_note := ""                 # which known object is standing beside it
var _spec: VBoxContainer              # the spec sheet down the left
var _bar: HBoxContainer               # the fitted parts along the bottom
var _frame_span := 0.0                # what the shot has to contain, metres
var _frame_target := Vector3.ZERO     # asset-supplied visual target, never a pack calculation
var _frame_distance_factor := 1.65
var _marine_mode := false
var _touch_points := {}
var _last_pinch_distance := 0.0


func _ready() -> void:
	_build_stage()
	_build_ui()
	_open_the_pipe()
	set_process(true)


# ---------------------------------------------------------------------------
# Stage: camera, lights, and the room the pack stands in.
#
# All of this is set dressing and none of it describes the pack. It earns its
# place for one reason: a pack floating in a black void has no size. Put it on
# a bench in a room with a known object beside it and a person can SEE that an
# EV pack is the size of a mattress and a wearable cell is smaller than a
# postage stamp — which is a fact the numbers state and nobody feels.
# ---------------------------------------------------------------------------
const BENCH_H := 0.85                 # a working bench, roughly hip height

func _build_stage() -> void:
	var env := Environment.new()
	var sky_material := ProceduralSkyMaterial.new()
	sky_material.sky_top_color = Color(0.12, 0.39, 0.61)
	sky_material.sky_horizon_color = Color(0.73, 0.86, 0.91)
	sky_material.ground_bottom_color = Color(0.035, 0.11, 0.16)
	sky_material.ground_horizon_color = Color(0.43, 0.65, 0.71)
	var sky := Sky.new()
	sky.sky_material = sky_material
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.69, 0.78, 0.82)
	env.ambient_light_energy = 0.58
	env.fog_enabled = true
	env.fog_light_color = Color(0.58, 0.75, 0.82)
	env.fog_density = 0.004
	var world := WorldEnvironment.new()
	world.environment = env
	add_child(world)

	# A workshop is lit from overhead and from one side. Two lights read as a
	# room; one reads as a product shot, which is the wrong feeling entirely.
	var key := DirectionalLight3D.new()
	key.rotation_degrees = Vector3(-58, -42, 0)
	key.light_energy = 1.48
	key.light_color = Color(1.0, 0.97, 0.92)
	# Asset scenes use clean engineering colour. Cast shadows made thin masts,
	# rails and roofs project large false wedges that looked like geometry.
	key.shadow_enabled = false
	add_child(key)
	var fill := DirectionalLight3D.new()
	fill.rotation_degrees = Vector3(-18, 128, 0)
	fill.light_energy = 0.3
	fill.light_color = Color(0.72, 0.83, 0.95)
	add_child(fill)

	_rig = Node3D.new()
	add_child(_rig)
	_boom = Node3D.new()
	_rig.add_child(_boom)
	_camera = Camera3D.new()
	_camera.fov = 44.0
	_camera.near = 0.01
	_camera.far = 400.0
	_boom.add_child(_camera)

	_room = Node3D.new()
	add_child(_room)
	_pack_root = Node3D.new()
	add_child(_pack_root)


# The room, rebuilt per pack because it has to fit one. A 12-metre bay around
# a wearable cell would leave the cell invisible; a 2-metre one around a bus
# pack would have it through the wall.
func _build_room(span_m: float) -> void:
	for child in _room.get_children():
		child.queue_free()
	var bay: float = clampf(span_m * 5.0, 3.0, 40.0)
	var wall_h: float = clampf(bay * 0.45, 2.4, 12.0)

	_room.add_child(_slab(Vector3(bay, 0.06, bay), Vector3(0, -0.03, 0),
			Color(0.115, 0.135, 0.128), 0.92, 0.0))                     # floor
	_room.add_child(_slab(Vector3(bay, wall_h, 0.08), Vector3(0, wall_h * 0.5, -bay * 0.5),
			Color(0.145, 0.168, 0.160), 0.95, 0.0))                     # back wall
	_room.add_child(_slab(Vector3(0.08, wall_h, bay), Vector3(-bay * 0.5, wall_h * 0.5, 0),
			Color(0.128, 0.150, 0.143), 0.95, 0.0))                     # side wall

	# Overhead shop lights. Cheap to add, and they are most of what makes a
	# room read as a workshop rather than a rendering of a floor.
	for i in 2:
		var x: float = (float(i) - 0.5) * bay * 0.34
		var tube := _slab(Vector3(bay * 0.34, 0.05, 0.12),
				Vector3(x, wall_h * 0.86, 0), Color(0.95, 0.96, 0.9), 0.4, 0.0)
		var m: StandardMaterial3D = (tube.mesh as BoxMesh).surface_get_material(0)
		m.emission_enabled = true
		m.emission = Color(1.0, 0.97, 0.88)
		m.emission_energy_multiplier = 1.6
		_room.add_child(tube)
		var lamp := OmniLight3D.new()
		lamp.position = Vector3(x, wall_h * 0.8, 0)
		lamp.omni_range = bay * 1.2
		lamp.light_energy = 1.5
		lamp.light_color = Color(1.0, 0.96, 0.88)
		_room.add_child(lamp)

	# The bench. Sized to the pack with a working margin, at hip height, so the
	# pack is presented the way it would actually be worked on.
	var bench: float = span_m * 1.5
	var bench_h: float = minf(BENCH_H, span_m * 0.9)
	_room.add_child(_slab(Vector3(bench, 0.05, bench), Vector3(0, bench_h, 0),
			Color(0.20, 0.225, 0.215), 0.7, 0.15))
	for sx in [-1.0, 1.0]:
		for sz in [-1.0, 1.0]:
			_room.add_child(_slab(Vector3(0.05, bench_h, 0.05),
					Vector3(sx * bench * 0.44, bench_h * 0.5, sz * bench * 0.44),
					Color(0.16, 0.18, 0.175), 0.8, 0.2))
	_bench_top = bench_h + 0.025
	_frame_span = span_m
	_frame_target = Vector3(0, _bench_top + span_m * 0.35, 0)
	_frame_distance_factor = 2.1
	_marine_mode = false
	_add_scale_reference(span_m, bench)


# The one piece of set dressing that is not decoration.
#
# Scale is the thing a table of millimetres cannot convey, so the room puts a
# KNOWN object next to the pack — and which object depends on how big the pack
# is, because a person standing next to a wearable cell tells you nothing.
# The card is ISO/IEC 7810 ID-1, the same 85.60 x 53.98 mm every bank card in
# the world is cut to, which makes it a genuine reference rather than a prop.
func _add_scale_reference(span_m: float, bench: float) -> void:
	var beside: float = bench * 0.5 + 0.35
	if span_m > 0.5:
		# A person, 1.75 m — and it has to BE 1.75 m, because that is the entire
		# job. The three parts stack head to floor without overlapping: legs
		# 0.00–0.85, torso 0.85–1.50, head 1.50–1.75. Crude on purpose; a
		# detailed figure invites looking at the figure, and it is here to be a
		# ruler.
		_room.add_child(_slab(Vector3(0.34, 0.85, 0.22), Vector3(beside, 0.425, 0),
				Color(0.20, 0.23, 0.27), 0.85, 0.0))                   # legs
		_room.add_child(_slab(Vector3(0.42, 0.65, 0.24), Vector3(beside, 1.175, 0),
				Color(0.26, 0.30, 0.34), 0.85, 0.0))                   # torso
		_room.add_child(_slab(Vector3(0.19, 0.25, 0.20), Vector3(beside, 1.625, 0),
				Color(0.30, 0.34, 0.38), 0.85, 0.0))                   # head
		_scale_note = "beside a 1.75 m person"
	elif span_m > 0.12:
		# A 330 ml drink can: 66 mm across, 115 mm tall, known to everyone.
		var can := MeshInstance3D.new()
		var cyl := CylinderMesh.new()
		cyl.top_radius = 0.033
		cyl.bottom_radius = 0.033
		cyl.height = 0.115
		var cm := StandardMaterial3D.new()
		cm.albedo_color = Color(0.72, 0.74, 0.76)
		cm.metallic = 0.8
		cm.roughness = 0.28
		cyl.surface_set_material(0, cm)
		can.mesh = cyl
		can.position = Vector3(beside, _bench_top + 0.0575, 0)
		_room.add_child(can)
		_scale_note = "beside a 330 ml can (66 x 115 mm)"
	else:
		# ISO/IEC 7810 ID-1 — every bank card on earth, to a tenth of a millimetre.
		_room.add_child(_slab(Vector3(0.0856, 0.0008, 0.05398),
				Vector3(beside, _bench_top + 0.0004, 0),
				Color(0.30, 0.42, 0.52), 0.5, 0.1))
		_scale_note = "beside a bank card (ISO/IEC 7810 ID-1, 85.6 x 54.0 mm)"


func _slab(size: Vector3, at: Vector3, col: Color, rough: float, metal: float) -> MeshInstance3D:
	var box := BoxMesh.new()
	box.size = size
	var m := StandardMaterial3D.new()
	m.albedo_color = col
	m.roughness = rough
	m.metallic = metal
	box.surface_set_material(0, m)
	var inst := MeshInstance3D.new()
	inst.mesh = box
	inst.position = at
	return inst


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

	# The spec sheet, down the left. A showroom states the numbers beside the
	# object rather than on another screen — and here they are the SAME numbers
	# the rest of the tool reports, arriving in the payload rather than being
	# worked out again.
	_spec = VBoxContainer.new()
	_spec.set_anchors_preset(Control.PRESET_TOP_LEFT)
	_spec.position = Vector2(16, 96)
	_spec.custom_minimum_size = Vector2(380, 0)
	_spec.add_theme_constant_override("separation", 2)
	layer.add_child(_spec)

	# The fitted parts, along the bottom. The equivalent of a tuning menu, and
	# it lists what is actually bolted to this pack — not a catalogue.
	_bar = HBoxContainer.new()
	_bar.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	_bar.position = Vector2(16, -66)
	_bar.add_theme_constant_override("separation", 22)
	layer.add_child(_bar)

	_hint = Label.new()
	_hint.add_theme_font_size_override("font_size", 12)
	_hint.modulate = Color(1, 1, 1, 0.45)
	_hint.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	_hint.position = Vector2(16, -24)
	_hint.text = "drag/swipe to orbit · wheel/pinch to zoom · click a part to name it"
	layer.add_child(_hint)

	# Compact camera presets remain useful on touch screens,
	# where precise orbit gestures are harder than on a desktop mouse.
	var views := GridContainer.new()
	views.columns = 2
	views.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	views.position = Vector2(-214, 16)
	views.add_theme_constant_override("h_separation", 8)
	views.add_theme_constant_override("v_separation", 8)
	layer.add_child(views)
	for label in ["BOW", "PORT", "AFT", "TOP"]:
		var button := Button.new()
		button.text = label
		button.custom_minimum_size = Vector2(94, 38)
		button.focus_mode = Control.FOCUS_NONE
		button.pressed.connect(_set_camera_preset.bind(label))
		views.add_child(button)

	_caption.text = "waiting for a design…"
	_status.text = ""


func _spec_row(key: String, value: String, tint: Color) -> void:
	var row := HBoxContainer.new()
	row.custom_minimum_size = Vector2(280, 0)
	var k := Label.new()
	k.text = key
	k.add_theme_font_size_override("font_size", 12)
	k.modulate = Color(1, 1, 1, 0.5)
	k.custom_minimum_size = Vector2(150, 0)
	var v := Label.new()
	v.text = value
	v.add_theme_font_size_override("font_size", 13)
	v.modulate = tint
	row.add_child(k)
	row.add_child(v)
	_spec.add_child(row)


func _spec_head(text: String) -> void:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 10)
	l.modulate = Color(0.42, 0.82, 0.74, 0.9)
	_spec.add_child(l)


func _spec_note(key: String, value: String, tint: Color) -> void:
	var box := VBoxContainer.new()
	box.custom_minimum_size = Vector2(380, 0)
	var k := Label.new()
	k.text = key
	k.add_theme_font_size_override("font_size", 10)
	k.modulate = Color(1, 1, 1, 0.5)
	var v := Label.new()
	v.text = value
	v.add_theme_font_size_override("font_size", 11)
	v.modulate = tint
	v.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	v.custom_minimum_size = Vector2(370, 0)
	box.add_child(k)
	box.add_child(v)
	_spec.add_child(box)


# Everything here is READ from the payload. Not one value is derived, which is
# the whole reason a renderer in another language is allowed near these numbers.
func _fill_spec(scene: Dictionary) -> void:
	for c in _spec.get_children():
		c.queue_free()
	for c in _bar.get_children():
		c.queue_free()

	var pack: Dictionary = scene.get("pack", {})
	var cell: Dictionary = scene.get("cell", {})
	var white := Color(1, 1, 1, 0.92)

	_spec_head("PACK")
	_spec_row("Topology", "%dS%dP" % [int(pack.get("s", 0)), int(pack.get("p", 0))], white)
	_spec_row("Cells", str(int(pack.get("cellCount", 0))), white)
	_spec_row("Chemistry", str(cell.get("chemistry", "—")), Color(cell.get("color", "#ffffff")))
	var o: Dictionary = pack.get("outer", {})
	_spec_row("Dimensions", "%d × %d × %d mm" % [int(o.get("x", 0)), int(o.get("y", 0)), int(o.get("z", 0))], white)
	var eff = pack.get("packingEfficiency", null)
	if eff != null:
		_spec_row("Packing", "%d%%" % int(round(float(eff) * 100.0)), white)

	var host = scene.get("host", null)
	if typeof(host) == TYPE_DICTIONARY and not host.is_empty():
		_spec_head("MACHINE")
		_spec_row("Type", str(host.get("name", "—")), white)
		_spec_row("Pack goes", str(host.get("mount", {}).get("name", "—")), white)
		var hs: Dictionary = host.get("sizeM", {})
		_spec_row("Envelope", "%.2f × %.2f × %.2f m" % [float(hs.get("x", 0)), float(hs.get("y", 0)), float(hs.get("z", 0))], white)
		# Whether the silhouette is measured or indicative is not a footnote —
		# it decides how much weight the picture is allowed to carry.
		var dims_label := str(host.get("dimsLabel", ""))
		if dims_label == "":
			dims_label = "measured cross-section" if str(host.get("dimsFrom", "")) == "frontal-area" else "indicative (class-typical)"
		_spec_row("Silhouette", dims_label,
				Color(1, 1, 1, 0.55))
		var fit_label := str(host.get("fitLabel", ""))
		if fit_label != "":
			_spec_row("Fit", fit_label, Color(0.95, 0.72, 0.35))
		elif host.get("fits", true) == false:
			_spec_row("Fit", "larger than the envelope on " + ", ".join(host.get("over", [])),
					Color(0.95, 0.72, 0.35))

		var model = host.get("model", null)
		if typeof(model) == TYPE_DICTIONARY and not model.is_empty():
			var marine_model := str(model.get("category", "")) == "marine"
			_spec_head("VESSEL MODEL · NOT CAD" if marine_model else "3D ASSET · NOT CAD")
			_spec_row("Asset", str(model.get("assetId", "—")), white)
			_spec_row("Version", str(model.get("version", "—")), white)
			_spec_row("Geometry", str(model.get("geometryDigest", "—")), Color(0.52, 0.82, 0.96))
			if marine_model:
				_spec_row("Datum", "design waterline z=0 · z up", Color(0.52, 0.82, 0.96))
				_spec_row("Baseline", "z=%+.2f m" % float(hs.get("baselineZ", hs.get("zMin", 0.0))), white)
				_spec_row("Vertical range", "%+.2f to %+.2f m" % [float(hs.get("zMin", 0.0)), float(hs.get("zMax", 0.0))], white)
			var evidence: Dictionary = host.get("evidence", {})
			var source_title := str(evidence.get("title", ""))
			if source_title != "":
				_spec_note("Source", source_title, Color(1, 1, 1, 0.72))
			var evidence_basis := str(evidence.get("basis", ""))
			if evidence_basis != "":
				_spec_note("Evidence basis", evidence_basis, Color(1, 1, 1, 0.62))
			var boundary := str(host.get("boundary", ""))
			if boundary != "":
				_spec_note("Model / study boundary", boundary, Color(0.95, 0.72, 0.35))
			var licence: Dictionary = model.get("licence", {})
			if not licence.is_empty():
				_spec_note("Reusable asset licence", "%s · %s" % [str(licence.get("spdx", "—")), str(licence.get("origin", "—"))], Color(0.52, 0.82, 0.96))

	for part in scene.get("parts", []):
		var nm := str(part.get("name", ""))
		if nm == "" or nm == "none fitted":
			continue
		var box := VBoxContainer.new()
		var cat := Label.new()
		cat.text = str(part.get("categoryName", "")).to_upper()
		cat.add_theme_font_size_override("font_size", 9)
		cat.modulate = Color(0.42, 0.82, 0.74, 0.75)
		var val := Label.new()
		val.text = nm if nm.length() <= 26 else nm.substr(0, 25) + "…"
		val.add_theme_font_size_override("font_size", 11)
		val.modulate = Color(1, 1, 1, 0.8)
		box.add_child(cat)
		box.add_child(val)
		_bar.add_child(box)


# ---------------------------------------------------------------------------
# The pipe. The host posts a scene into the page; the shell hands it here.
# ---------------------------------------------------------------------------
func _open_the_pipe() -> void:
	if not OS.has_feature("web"):
		# Run from the editor with no host: draw something so the scene can be
		# opened and worked on without the whole app around it. The headless CI
		# smoke supplies its own payload; skipping the editor MultiMesh fixture
		# avoids asking Godot's deliberately mesh-less dummy renderer to draw it.
		if DisplayServer.get_name() != "headless":
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

	# Two ways to stand in front of it, and the scene decides which.
	#
	#   SHOWROOM — when the payload names a host machine. The pack sits where
	#   it would sit in the car, the boat, the robot: the only question anyone
	#   has at the start is "does it fit, and where does it go", and no table
	#   of millimetres has ever answered it.
	#
	#   BENCH — otherwise. The pack on a workbench in a lit workshop, with a
	#   known object beside it for scale.
	var outer: Dictionary = pack.get("outer", {})
	var span: float = maxf(maxf(float(outer.get("x", 200.0)), float(outer.get("y", 200.0))),
			float(outer.get("z", 200.0))) * MM
	var host = scene.get("host", null)
	if typeof(host) == TYPE_DICTIONARY and not host.is_empty():
		_build_studio(host, outer)
	else:
		_build_room(span)
		_pack_root.position = Vector3(0, _bench_top + float(outer.get("z", 0.0)) * MM * 0.5, 0)

	_add_cells(cell, cells)
	for part in scene.get("parts", []):
		_add_part(part)

	_fill_spec(scene)
	if _scale_note != "":
		_hint.text = "drag to orbit · wheel to zoom · click a part to name it   —   " + _scale_note
	_frame_on(pack)
	_have_scene = true


# ---------------------------------------------------------------------------
# Showroom: the machine, and the pack inside it
# ---------------------------------------------------------------------------
#
# The silhouette is a massing block and nothing more. Its cross-section comes
# from a measured frontal area where the application has one; its length is
# class-typical and the caption says so. It exists to give the pack somewhere
# to sit — the instant it grows wheelbases and overhangs, someone will measure
# it and it will be wrong.
#
# The PACK inside it is not indicative. Every cell, every millimetre, at true
# scale. So when a 250 kWh pack laid flat is visibly wider than the bus it is
# meant to go in, that is the design telling the truth about itself.
func _build_studio(host: Dictionary, outer: Dictionary) -> void:
	for child in _room.get_children():
		child.queue_free()
	_bench_top = 0.0

	var size: Dictionary = host.get("sizeM", {})
	var hw := float(size.get("x", 2.0))
	var hl := float(size.get("y", 4.0))
	var hh := float(size.get("z", 1.5))
	var z_min := float(size.get("zMin", 0.0))
	var waterline_y := float(size.get("waterlineZ", 0.0)) - z_min
	var stage_r: float = maxf(hw, hl) * 1.15
	var model = host.get("model", null)
	_marine_mode = typeof(model) == TYPE_DICTIONARY and str(model.get("scenePreset", "")) == "ocean"

	if _marine_mode:
		_build_ocean(stage_r, waterline_y)
	else:
		# A lit turntable remains useful for road, robot and product assets.
		var disc := MeshInstance3D.new()
		var cyl := CylinderMesh.new()
		cyl.top_radius = stage_r
		cyl.bottom_radius = stage_r
		cyl.height = 0.02
		var dm := StandardMaterial3D.new()
		dm.albedo_color = Color(0.11, 0.13, 0.128)
		dm.roughness = 0.35
		dm.metallic = 0.25
		cyl.surface_set_material(0, dm)
		disc.mesh = cyl
		disc.position = Vector3(0, -0.01, 0)
		_room.add_child(disc)
		_room.add_child(_slab(Vector3(stage_r * 8.0, 0.02, stage_r * 8.0),
				Vector3(0, -0.03, 0), Color(0.038, 0.048, 0.046), 0.95, 0.0))

	var spot := SpotLight3D.new()
	spot.position = Vector3(0, hh * 3.0 + 2.0, 0)
	spot.rotation_degrees = Vector3(-90, 0, 0)
	spot.spot_range = hh * 6.0 + 8.0
	spot.spot_angle = 42.0
	spot.light_energy = 3.0
	spot.light_color = Color(1.0, 0.98, 0.94)
	_room.add_child(spot)

	# The studio floor is the supplied lowest display baseline. This translucent
	# plane marks the separately supplied design waterline, so underwater hull
	# and propulsion geometry remains visible below z=0 rather than being folded
	# into an ambiguous all-positive envelope.
	if not _marine_mode:
		_add_waterline_marker(hw, hl, waterline_y)

	# Every host arrives as a complete portable asset payload. Sizes, meshes and
	# positions are not re-derived here: the renderer only maps the repository's
	# z-up axes to Godot's y-up axes and draws the declared primitives.
	if typeof(model) == TYPE_DICTIONARY and not model.is_empty():
		_build_payload_model(model, -z_min)
	else:
		_fail("3D asset payload missing for " + str(host.get("kind", "unknown host")))
	if not _marine_mode:
		_add_wireframe(Vector3(hw, hh, hl), Vector3(0, hh * 0.5, 0), Color(0.36, 0.78, 0.72))

	# The pack, seated where the mounting puts it. Mount decides the seat, so a
	# pack that grows moves within the machine instead of the machine rescaling
	# around it — which is exactly what makes an oversized pack visibly burst out.
	var seat: Dictionary = host.get("seatM", {})
	_pack_root.position = Vector3(
		float(seat.get("x", 0.0)),
		hh * 0.5 + float(seat.get("z", 0.0)),
		float(seat.get("y", 0.0)))
	# The MACHINE is what has to be in shot now, not the pack. Framing on the
	# pack put the camera inside the car — a wireframe filling the screen from
	# the inside reads as a bug, not as a vehicle.
	_frame_span = maxf(maxf(hw, hl), hh)
	_frame_target = Vector3(0, hh * 0.45, 0)
	_frame_distance_factor = 1.65
	if typeof(model) == TYPE_DICTIONARY:
		var presentation: Dictionary = model.get("presentation", {})
		var target: Dictionary = presentation.get("targetM", {})
		_frame_target = Vector3(
				float(target.get("x", 0.0)),
				float(target.get("z", hh * 0.45)) - z_min,
				float(target.get("y", 0.0)))
		_frame_distance_factor = float(presentation.get("distanceFactor", 1.65))
		_orbit_yaw = deg_to_rad(float(presentation.get("orbitYawDeg", 34.0)))
		_orbit_pitch = deg_to_rad(float(presentation.get("orbitPitchDeg", -18.0)))
	_scale_note = "%s · %s" % [str(host.get("name", "")), str(host.get("mount", {}).get("name", ""))]


func _build_ocean(stage_r: float, waterline_y: float) -> void:
	var water := MeshInstance3D.new()
	water.name = "WaterPlane"
	var plane := PlaneMesh.new()
	plane.size = Vector2(stage_r * 7.0, stage_r * 7.0)
	var water_material := StandardMaterial3D.new()
	water_material.albedo_color = Color(0.42, 0.66, 0.72)
	water_material.roughness = 1.0
	water_material.metallic = 0.0
	water_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	plane.surface_set_material(0, water_material)
	water.mesh = plane
	water.position = Vector3(0, waterline_y - 0.035, 0)
	_room.add_child(water)

	# No decorative wake or projected footprint. Motion belongs to simulation
	# overlays; the base asset view stays visually neutral.


func _add_waterline_marker(width_m: float, length_m: float, at_y: float) -> void:
	var marker := _slab(
			Vector3(width_m * 1.04, 0.012, length_m * 1.04),
			Vector3(0, at_y, 0), Color(0.20, 0.58, 0.78, 0.10), 0.35, 0.0)
	marker.name = "DesignWaterlineZ0"
	var material: StandardMaterial3D = (marker.mesh as BoxMesh).surface_get_material(0)
	material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	material.cull_mode = BaseMaterial3D.CULL_DISABLED
	_room.add_child(marker)


# Edges only. A box with visible edges reads as an envelope; a box without them
# reads as a solid, and this one is deliberately not solid.
func _add_wireframe(size: Vector3, at: Vector3, col: Color) -> void:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_LINES)
	var h := size * 0.5
	var corners := [
		Vector3(-h.x, -h.y, -h.z), Vector3(h.x, -h.y, -h.z),
		Vector3(h.x, -h.y, h.z), Vector3(-h.x, -h.y, h.z),
		Vector3(-h.x, h.y, -h.z), Vector3(h.x, h.y, -h.z),
		Vector3(h.x, h.y, h.z), Vector3(-h.x, h.y, h.z),
	]
	var edges := [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]]
	for e in edges:
		st.add_vertex(corners[e[0]])
		st.add_vertex(corners[e[1]])
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.albedo_color = col
	mat.vertex_color_use_as_albedo = false
	var inst := MeshInstance3D.new()
	inst.mesh = st.commit()
	inst.material_override = mat
	inst.position = at
	_room.add_child(inst)


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
	if _frame_span > 0.0:
		span = _frame_span
	# Far enough back that the scale reference is IN the shot. Framing on the
	# pack alone crops the person, which throws away the only thing in the
	# room that tells you how big any of it is.
	var reference_h: float = 1.75 if span > 0.5 else 0.2
	_target_distance = maxf(0.35, maxf(span * _frame_distance_factor, reference_h * 1.9))
	_distance = _target_distance
	# Orbit around the pack where it now sits, not around the floor. Circling a
	# point under the bench puts the subject at the top of the frame and the
	# concrete in the middle of it.
	_rig.position = _frame_target if _frame_span > 0.0 else _pack_root.position


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
	elif event is InputEventMagnifyGesture:
		_target_distance = clampf(_target_distance / maxf(event.factor, 0.1), 0.15, 160.0)
	elif event is InputEventScreenTouch:
		if event.pressed:
			_touch_points[event.index] = event.position
		else:
			_touch_points.erase(event.index)
		_last_pinch_distance = _current_pinch_distance()
	elif event is InputEventScreenDrag:
		_touch_points[event.index] = event.position
		if _touch_points.size() == 1:
			_orbit_yaw -= event.relative.x * 0.008
			_orbit_pitch = clamp(_orbit_pitch - event.relative.y * 0.008, -1.45, 1.45)
		elif _touch_points.size() >= 2:
			var pinch := _current_pinch_distance()
			if pinch > 0.0 and _last_pinch_distance > 0.0:
				_target_distance = clampf(_target_distance * (_last_pinch_distance / pinch), 0.15, 160.0)
			_last_pinch_distance = pinch


func _current_pinch_distance() -> float:
	if _touch_points.size() < 2:
		return 0.0
	var points: Array = _touch_points.values()
	return (points[0] as Vector2).distance_to(points[1] as Vector2)


func _set_camera_preset(label: String) -> void:
	match label:
		"BOW":
			_orbit_yaw = 0.0
			_orbit_pitch = deg_to_rad(-12.0)
		"PORT":
			_orbit_yaw = deg_to_rad(-90.0)
			_orbit_pitch = deg_to_rad(-10.0)
		"AFT":
			_orbit_yaw = PI
			_orbit_pitch = deg_to_rad(-12.0)
		"TOP":
			_orbit_yaw = deg_to_rad(28.0)
			_orbit_pitch = deg_to_rad(-72.0)


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


# Draw-only payload consumer for every reusable 3D asset. Every primitive's
# mesh, bounds, role, material and identity is supplied by JavaScript. Axis
# mapping is a renderer concern; geometry and engineering calculations are not.
func _build_payload_model(model: Dictionary, vertical_offset_m: float) -> void:
	var primitive_index := 0
	var marine_asset := str(model.get("category", "")) == "marine"
	for raw in model.get("primitives", []):
		if typeof(raw) != TYPE_DICTIONARY:
			continue
		var primitive: Dictionary = raw
		var kind := str(primitive.get("kind", ""))
		if kind not in ["box", "mesh", "cylinder"]:
			continue
		var size_m: Dictionary = primitive.get("sizeM", {})
		var at_m: Dictionary = primitive.get("atM", {})
		var render_size := Vector3(
				float(size_m.get("x", 0.0)),
				float(size_m.get("z", 0.0)),
				float(size_m.get("y", 0.0)))
		var render_at := Vector3(
				float(at_m.get("x", 0.0)),
				float(at_m.get("z", 0.0)) + vertical_offset_m,
				float(at_m.get("y", 0.0)))
		if render_size.x <= 0.0 or render_size.y <= 0.0 or render_size.z <= 0.0:
			continue
		var instance: MeshInstance3D = null
		match kind:
			"box":
				var box_mesh := BoxMesh.new()
				box_mesh.size = render_size
				box_mesh.surface_set_material(0, _asset_material(primitive))
				instance = MeshInstance3D.new()
				instance.mesh = box_mesh
			"cylinder":
				var cylinder_mesh := CylinderMesh.new()
				cylinder_mesh.top_radius = float(primitive.get("radiusM", 0.0))
				cylinder_mesh.bottom_radius = float(primitive.get("radiusM", 0.0))
				cylinder_mesh.height = float(primitive.get("heightM", 0.0))
				cylinder_mesh.radial_segments = 18
				cylinder_mesh.surface_set_material(0, _asset_material(primitive))
				instance = MeshInstance3D.new()
				instance.mesh = cylinder_mesh
				match str(primitive.get("axis", "z")):
					"x": instance.rotation_degrees = Vector3(0, 0, 90)
					"y": instance.rotation_degrees = Vector3(90, 0, 0)
			"mesh":
				var vertices: Array = primitive.get("vertices", [])
				var triangles: Array = primitive.get("triangles", [])
				var surface := SurfaceTool.new()
				surface.begin(Mesh.PRIMITIVE_TRIANGLES)
				var valid_faces := 0
				for face_raw in triangles:
					if typeof(face_raw) != TYPE_ARRAY or face_raw.size() != 3:
						continue
					var valid_face := true
					for raw_index in face_raw:
						var vertex_index := int(raw_index)
						if vertex_index < 0 or vertex_index >= vertices.size() or typeof(vertices[vertex_index]) != TYPE_ARRAY or vertices[vertex_index].size() != 3:
							valid_face = false
							break
					if not valid_face:
						continue
					for raw_index in face_raw:
						var vertex: Array = vertices[int(raw_index)]
						surface.add_vertex(Vector3(float(vertex[0]), float(vertex[2]), float(vertex[1])))
					valid_faces += 1
				if valid_faces == 0:
					continue
				surface.generate_normals()
				surface.set_material(_asset_material(primitive))
				instance = MeshInstance3D.new()
				instance.mesh = surface.commit()
		if instance == null:
			continue
		instance.position = render_at
		instance.name = str(primitive.get("name", "AssetPart%d" % primitive_index)).validate_node_name()
		_room.add_child(instance)
		var role := str(primitive.get("role", "vessel-part"))
		var item_id := "%s:%s:%d" % ["vessel" if marine_asset else "asset", role, primitive_index]
		_pickables.append({
			"aabb": AABB(render_at - render_size * 0.5, render_size),
			"name": str(primitive.get("name", role)),
			"category": ("Vessel " if marine_asset else "Host ") + role.capitalize(),
			"id": item_id,
		})
		primitive_index += 1


func _asset_material(primitive: Dictionary) -> StandardMaterial3D:
	var definition: Dictionary = primitive.get("material", {})
	var result := StandardMaterial3D.new()
	var color := Color(str(definition.get("color", primitive.get("tint", "#5f8f96"))))
	color.a = float(definition.get("opacity", 1.0))
	result.albedo_color = color
	result.roughness = clampf(float(definition.get("roughness", 0.55)), 0.0, 1.0)
	result.metallic = clampf(float(definition.get("metallic", 0.0)), 0.0, 1.0)
	# One calm technical style across the reusable asset library. Shape is
	# communicated by geometry and colour separation, never cast shadows.
	result.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	if color.a < 0.999:
		result.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		result.cull_mode = BaseMaterial3D.CULL_DISABLED
	return result
