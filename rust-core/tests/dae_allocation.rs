use battery_design_core::dae::DaeResidualSystem;
use battery_design_core::equations::{Block, BlockKind, EquationGraph, Quantity, SolverSettings};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct ThreadTrackingAllocator;

thread_local! {
    static TRACK_ALLOCATIONS: Cell<bool> = const { Cell::new(false) };
    static ALLOCATION_COUNT: Cell<usize> = const { Cell::new(0) };
}

fn record_allocation() {
    if TRACK_ALLOCATIONS
        .try_with(|tracking| tracking.get())
        .unwrap_or(false)
    {
        ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
    }
}

unsafe impl GlobalAlloc for ThreadTrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_allocation();
        unsafe { System.realloc(pointer, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: ThreadTrackingAllocator = ThreadTrackingAllocator;

fn count_allocations(action: impl FnOnce()) -> usize {
    // Initialize both thread-local cells before enabling measurement so their
    // first access cannot contaminate the result.
    TRACK_ALLOCATIONS.with(|tracking| tracking.set(false));
    ALLOCATION_COUNT.with(|count| count.set(0));
    TRACK_ALLOCATIONS.with(|tracking| tracking.set(true));
    action();
    TRACK_ALLOCATIONS.with(|tracking| tracking.set(false));
    ALLOCATION_COUNT.with(Cell::get)
}

#[test]
fn caller_buffer_dae_success_paths_allocate_zero_times() {
    let mut graph = EquationGraph::new();
    let source = graph
        .add_block(Block::new(
            "scheduled command",
            Quantity::Dimensionless,
            BlockKind::StepSource {
                before: 4.0,
                after: 8.0,
                at_s: 1.0,
            },
        ))
        .unwrap();
    let state = graph
        .add_block(Block::new(
            "state",
            Quantity::Dimensionless,
            BlockKind::Integrator {
                initial: 2.0,
                rate: Quantity::Dimensionless,
                gain: 0.5,
            },
        ))
        .unwrap();
    let output = graph
        .add_block(Block::new(
            "scaled output",
            Quantity::Dimensionless,
            BlockKind::Gain {
                gain: 3.0,
                input: Quantity::Dimensionless,
            },
        ))
        .unwrap();
    graph.connect(source, state, 0).unwrap();
    graph.connect(state, output, 0).unwrap();
    let graph = graph.compile().unwrap();
    let settings = SolverSettings {
        end_s: 0.0,
        ..SolverSettings::default()
    };
    let system = DaeResidualSystem::lower(&graph, 0.0, &settings).unwrap();
    let requirements = system.buffer_requirements();

    // Every allocation, including buffer sizing, is outside the measured
    // callback region. The same buffers are deliberately reused many times.
    let mut residual = vec![0.0; requirements.residual];
    let mut jacobian = vec![0.0; requirements.jacobian_values];
    let mut outputs = vec![0.0; requirements.outputs];
    let mut ids = vec![0.0; requirements.id_vector];
    let mut initial_y = vec![0.0; requirements.y];
    let mut initial_yp = vec![0.0; requirements.yp];
    let mut event_times = vec![0.0; requirements.event_times];

    let allocations = count_allocations(|| {
        for _ in 0..128 {
            system
                .residual_into(0.0, system.initial_y(), system.initial_yp(), &mut residual)
                .unwrap();
            system
                .residual_event_left_limit_into(
                    0,
                    system.initial_y(),
                    system.initial_yp(),
                    &mut residual,
                )
                .unwrap();
            system
                .jacobian_values_into(
                    0.0,
                    10.0,
                    system.initial_y(),
                    system.initial_yp(),
                    &mut jacobian,
                )
                .unwrap();
            system
                .outputs_into(system.initial_y(), &mut outputs)
                .unwrap();
            system.id_vector_into(&mut ids).unwrap();
            system
                .initial_conditions_into(&mut initial_y, &mut initial_yp)
                .unwrap();
            system.event_times_into(&mut event_times).unwrap();
        }
    });

    assert_eq!(allocations, 0, "DAE caller-buffer success paths allocated");
}
