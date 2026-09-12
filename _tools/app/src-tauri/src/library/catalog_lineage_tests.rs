use super::*;

fn work(id: i64, parent: Option<i64>, first: Option<i64>, current: Option<i64>) -> LineageWork {
    LineageWork {
        id,
        token: Some(format!("token-{id}")),
        parent: parent.map(link),
        first: first.map(link),
        current: current.map(link),
    }
}

fn link(id: i64) -> LineageLink {
    LineageLink {
        target: id,
        key: Some(format!("token-{id}")),
    }
}

fn assert_separate(works: &[LineageWork]) {
    let plan = analyze(works);
    let mut ids: Vec<_> = works.iter().map(|w| vec![w.id]).collect();
    ids.sort();
    assert_eq!(plan.components, ids);
    assert!(plan.terminal_ids.is_empty());
    assert!(!plan.diagnostics.is_empty());
}

#[test]
fn normal_two_editions_and_reverse_current_are_not_a_cycle() {
    let plan = analyze(&[
        work(1, None, None, Some(2)),
        work(2, Some(1), Some(1), None),
    ]);
    assert_eq!(plan.components, vec![vec![1, 2]]);
    assert_eq!(plan.terminal_ids, BTreeSet::from([2]));
    assert!(plan.diagnostics.is_empty());
}

#[test]
fn long_chain_uses_links_not_numeric_ids_for_terminal() {
    let plan = analyze(&[
        work(30, None, None, Some(20)),
        work(10, Some(30), Some(30), Some(20)),
        work(20, Some(10), Some(30), None),
    ]);
    assert_eq!(plan.components, vec![vec![10, 20, 30]]);
    assert_eq!(plan.terminal_ids, BTreeSet::from([20]));
}

#[test]
fn singleton_has_no_proven_edition_terminal_bonus() {
    let plan = analyze(&[work(1, None, None, None)]);
    assert_eq!(plan.components, vec![vec![1]]);
    assert!(plan.terminal_ids.is_empty());
    assert!(plan.diagnostics.is_empty());
}

#[test]
fn nonpositive_source_id_cannot_join_a_valid_chain() {
    assert_separate(&[work(1, None, None, None), work(-1, Some(1), None, None)]);
}

#[test]
fn missing_reference_poisoning_does_not_partially_merge() {
    assert_separate(&[
        work(1, None, None, None),
        work(2, Some(1), Some(99), None),
        work(3, Some(2), Some(1), None),
    ]);
}

#[test]
fn self_and_nonpositive_links_are_rejected() {
    for target in [0, -1, 2] {
        assert_separate(&[
            work(1, None, None, None),
            work(2, Some(1), Some(target), None),
        ]);
    }
}

#[test]
fn invalid_keys_poison_both_existing_sides() {
    for key in [None, Some(String::new()), Some("wrong".into())] {
        let mut second = work(2, Some(1), None, None);
        second.parent.as_mut().unwrap().key = key;
        assert_separate(&[
            work(1, None, None, None),
            second,
            work(3, Some(2), None, None),
        ]);
    }
}

#[test]
fn parent_cycle_and_branching_are_rejected() {
    assert_separate(&[work(1, Some(2), None, None), work(2, Some(1), None, None)]);
    assert_separate(&[
        work(1, None, None, None),
        work(2, Some(1), None, None),
        work(3, Some(1), None, None),
    ]);
}

#[test]
fn conflicting_first_roots_poison_entire_chain() {
    assert_separate(&[
        work(1, None, None, None),
        work(2, Some(1), None, None),
        work(3, Some(2), Some(2), None),
    ]);
    assert_separate(&[
        work(1, Some(4), None, None),
        work(2, Some(1), Some(1), None),
        work(4, None, None, None),
    ]);
}

#[test]
fn stale_current_to_middle_is_valid_when_forward_chains_converge() {
    let plan = analyze(&[
        work(1, None, None, Some(2)),
        work(2, Some(1), Some(1), Some(3)),
        work(3, Some(2), Some(1), None),
    ]);
    assert_eq!(plan.components, vec![vec![1, 2, 3]]);
    assert_eq!(plan.terminal_ids, BTreeSet::from([3]));
}

#[test]
fn stale_current_sinks_can_differ_when_strong_order_proves_same_terminal() {
    let plan = analyze(&[
        work(1, None, None, Some(2)),
        work(2, Some(1), Some(1), None),
        work(3, Some(2), Some(1), Some(4)),
        work(4, Some(3), Some(1), None),
    ]);
    assert_eq!(plan.components, vec![vec![1, 2, 3, 4]]);
    assert_eq!(plan.terminal_ids, BTreeSet::from([4]));
    assert!(plan.diagnostics.is_empty());
}

#[test]
fn current_cycles_and_cross_lineage_references_are_rejected() {
    assert_separate(&[
        work(1, None, None, Some(2)),
        work(2, Some(1), None, Some(1)),
    ]);
    assert_separate(&[
        work(1, None, None, Some(3)),
        work(2, Some(1), None, None),
        work(3, None, None, None),
    ]);
}

#[test]
fn missing_intermediate_never_reconnects_siblings() {
    assert_separate(&[
        work(1, None, None, None),
        work(3, Some(2), Some(1), None),
        work(4, Some(2), Some(1), None),
    ]);
}

#[test]
fn current_only_does_not_merge() {
    let plan = analyze(&[work(1, None, None, Some(2)), work(2, None, None, None)]);
    assert_eq!(plan.components, vec![vec![1], vec![2]]);
    assert!(plan.terminal_ids.is_empty());
}

#[test]
fn first_only_pair_is_proven_but_unordered_siblings_are_ambiguous() {
    let plan = analyze(&[work(1, None, None, None), work(2, None, Some(1), None)]);
    assert_eq!(plan.components, vec![vec![1, 2]]);
    assert_eq!(plan.terminal_ids, BTreeSet::from([2]));
    assert_separate(&[
        work(1, None, None, None),
        work(2, None, Some(1), None),
        work(3, None, Some(1), None),
    ]);
}

#[test]
fn input_order_cannot_change_components_or_diagnostics() {
    let mut works = vec![
        work(10, None, None, None),
        work(30, Some(10), None, None),
        work(2, Some(99), None, None),
        work(7, None, None, None),
    ];
    let expected = analyze(&works);
    works.reverse();
    assert_eq!(analyze(&works), expected);
}

#[test]
fn oversized_component_fails_safe_without_recursive_traversal() {
    let works: Vec<_> = (1..=4097)
        .map(|id| work(id, (id > 1).then_some(id - 1), None, None))
        .collect();
    assert_separate(&works);
}
