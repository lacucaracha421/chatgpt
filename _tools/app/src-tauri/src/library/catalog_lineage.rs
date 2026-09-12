//! Conservative, in-memory validation of provider-authenticated edition links.
use std::collections::{BTreeMap, BTreeSet};

const MAX_COMPONENT_WORKS: usize = 4096;

#[derive(Clone, Debug)]
pub(super) struct LineageLink {
    pub target: i64,
    pub key: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct LineageWork {
    pub id: i64,
    pub token: Option<String>,
    pub parent: Option<LineageLink>,
    pub first: Option<LineageLink>,
    pub current: Option<LineageLink>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct LineagePlan {
    pub components: Vec<Vec<i64>>,
    pub terminal_ids: BTreeSet<i64>,
    pub diagnostics: Vec<LineageDiagnostic>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct LineageDiagnostic {
    pub work_id: i64,
    pub reason: String,
}

pub(super) fn analyze(works: &[LineageWork]) -> LineagePlan {
    // The caller supplies unique positive IDs from one provider. Sorting also makes
    // diagnostics and graph traversal independent of database/input order.
    let mut ordered: Vec<_> = works.iter().collect();
    ordered.sort_by_key(|work| work.id);
    let by_id: BTreeMap<_, _> = ordered.iter().enumerate().map(|(i, w)| (w.id, i)).collect();
    let count = ordered.len();
    let mut potential = vec![Vec::new(); count];
    let mut strong = vec![Vec::new(); count];
    let mut successors = vec![BTreeSet::new(); count];
    let mut parents = vec![None; count];
    let mut firsts = vec![None; count];
    let mut currents = vec![None; count];
    let mut reasons = vec![BTreeSet::new(); count];

    for (i, work) in ordered.iter().enumerate() {
        if work.id <= 0 {
            reasons[i].insert("nonpositive_work_id".into());
        }
        for (kind, link) in [
            ("parent", &work.parent),
            ("first", &work.first),
            ("current", &work.current),
        ] {
            let Some(link) = link else { continue };
            let target = by_id.get(&link.target).copied();
            // Even a bad key implicates the existing endpoint. Missing IDs never
            // become graph vertices, so unrelated missing-ID siblings stay apart.
            if let Some(j) = target {
                potential[i].push(j);
                potential[j].push(i);
            }
            let failure = if link.target <= 0 {
                Some("nonpositive_target")
            } else if link.target == work.id {
                Some("self_link")
            } else if target.is_none() {
                Some("missing_target")
            } else if link.key.as_deref().is_none_or(|key| key.trim().is_empty()) {
                Some("missing_key")
            } else if link.key != ordered[target.unwrap()].token {
                Some("key_mismatch")
            } else {
                None
            };
            if let Some(failure) = failure {
                reasons[i].insert(format!("{kind}_{failure}"));
                continue;
            }
            let j = target.unwrap();
            match kind {
                "parent" => parents[i] = Some(j),
                "first" => firsts[i] = Some(j),
                _ => currents[i] = Some(j),
            }
            if kind != "current" {
                strong[i].push(j);
                strong[j].push(i);
                successors[j].insert(i);
            }
        }
    }

    let potential_components = connected_components(&potential);
    for component in &potential_components {
        if component.len() > MAX_COMPONENT_WORKS {
            for &i in component {
                reasons[i].insert("component_limit_exceeded".into());
            }
        }
    }
    let strong_components = connected_components(&strong);
    let mut strong_group = vec![0; count];
    for (group, component) in strong_components.iter().enumerate() {
        for &i in component {
            strong_group[i] = group;
        }
    }
    let mut terminals = BTreeSet::new();
    for component in &strong_components {
        if component.iter().any(|&i| !reasons[i].is_empty()) {
            continue;
        }
        if let Some((i, reason)) = validate_component(
            component,
            &successors,
            &parents,
            &firsts,
            &currents,
            &strong_group,
            &mut terminals,
        ) {
            reasons[i].insert(reason.into());
        }
    }

    // Reject the entire implicated graph, including otherwise valid subchains.
    let mut rejected = vec![false; count];
    for component in potential_components {
        if component.iter().any(|&i| !reasons[i].is_empty()) {
            for i in component {
                rejected[i] = true;
                if reasons[i].is_empty() {
                    reasons[i].insert("linked_component_suspicious".into());
                }
            }
        }
    }
    let mut components = Vec::new();
    for component in strong_components {
        if component.iter().any(|&i| rejected[i]) {
            components.extend(component.iter().map(|&i| vec![ordered[i].id]));
        } else {
            components.push(component.iter().map(|&i| ordered[i].id).collect());
        }
    }
    components.sort();
    LineagePlan {
        components,
        terminal_ids: terminals
            .into_iter()
            .filter(|&i| !rejected[i])
            .map(|i| ordered[i].id)
            .collect(),
        diagnostics: reasons
            .into_iter()
            .enumerate()
            .filter(|(_, reasons)| !reasons.is_empty())
            .map(|(i, reasons)| LineageDiagnostic {
                work_id: ordered[i].id,
                reason: reasons.into_iter().collect::<Vec<_>>().join(","),
            })
            .collect(),
    }
}

fn connected_components(edges: &[Vec<usize>]) -> Vec<Vec<usize>> {
    let mut visited = vec![false; edges.len()];
    let mut result = Vec::new();
    for start in 0..edges.len() {
        if visited[start] {
            continue;
        }
        visited[start] = true;
        let mut pending = vec![start];
        let mut component = Vec::new();
        while let Some(i) = pending.pop() {
            component.push(i);
            for &j in &edges[i] {
                if !visited[j] {
                    visited[j] = true;
                    pending.push(j);
                }
            }
        }
        component.sort_unstable();
        result.push(component);
    }
    result
}

fn validate_component(
    component: &[usize],
    successors: &[BTreeSet<usize>],
    parents: &[Option<usize>],
    firsts: &[Option<usize>],
    currents: &[Option<usize>],
    strong_group: &[usize],
    terminals: &mut BTreeSet<usize>,
) -> Option<(usize, &'static str)> {
    let mut parent_children = BTreeMap::<usize, usize>::new();
    let mut incoming: BTreeMap<usize, usize> = component.iter().map(|&i| (i, 0)).collect();
    for &i in component {
        if let Some(parent) = parents[i] {
            let children = parent_children.entry(parent).or_default();
            *children += 1;
            if *children > 1 {
                return Some((parent, "parent_branch"));
            }
        }
        for next in &successors[i] {
            *incoming.get_mut(next).unwrap() += 1;
        }
        if let Some(current) = currents[i] {
            if strong_group[i] != strong_group[current] {
                return Some((i, "current_outside_proven_lineage"));
            }
        }
    }
    // Only one topological ordering proves a linear edition sequence. In
    // particular, sharing a first edition does not order unknown siblings.
    let mut ready: BTreeSet<_> = incoming
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(&i, _)| i)
        .collect();
    let mut order = Vec::with_capacity(component.len());
    while !ready.is_empty() {
        if ready.len() != 1 {
            return Some((component[0], "ambiguous_edition_order"));
        }
        let i = ready.pop_first().unwrap();
        order.push(i);
        for next in &successors[i] {
            let degree = incoming.get_mut(next).unwrap();
            *degree -= 1;
            if *degree == 0 {
                ready.insert(*next);
            }
        }
    }
    if order.len() != component.len() {
        return Some((component[0], "parent_first_cycle"));
    }
    let root = order[0];
    let rank: BTreeMap<_, _> = order
        .iter()
        .enumerate()
        .map(|(rank, &i)| (i, rank))
        .collect();
    for &i in component {
        if firsts[i].is_some_and(|first| first != root) {
            return Some((i, "conflicting_first_root"));
        }
        if let Some(current) = currents[i] {
            if rank[&current] <= rank[&i] {
                return Some((i, "current_not_forward"));
            }
        }
    }
    // Current may stop at any later edition: the unique strong order proves
    // convergence on the terminal even when explicit Current pointers are stale.
    if order.len() > 1 {
        terminals.insert(*order.last().unwrap());
    }
    None
}

#[cfg(test)]
#[path = "catalog_lineage_tests.rs"]
mod tests;
