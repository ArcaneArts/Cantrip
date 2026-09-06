//! Bounded hierarchy traversal; native identity comparison is supplied by AX.
use std::collections::VecDeque;

pub(crate) struct WindowTraversal<T> {
    pending: VecDeque<(T, usize)>,
    seen: Vec<T>,
    node_limit: usize,
    child_limit: usize,
    depth_limit: usize,
    pub(crate) truncated: bool,
}
impl<T: Clone> WindowTraversal<T> {
    pub(crate) fn new(root: T, targeted: bool) -> Self {
        let node_limit = if targeted { 512 } else { 128 };
        Self {
            pending: VecDeque::from([(root, 0)]),
            seen: vec![],
            node_limit,
            // Targeted lookup uses its overall budget rather than stopping at
            // 128 siblings or 24 wrappers inside an otherwise small hierarchy.
            child_limit: if targeted { node_limit } else { 32 },
            depth_limit: if targeted { node_limit } else { 12 },
            truncated: false,
        }
    }
    pub(crate) fn next(&mut self) -> Option<(T, usize)> {
        let (element, depth) = self.pending.pop_front()?;
        self.seen.push(element.clone());
        Some((element, depth))
    }
    pub(crate) fn child_limit(&self, depth: usize) -> usize {
        if depth >= self.depth_limit {
            return 1;
        }
        // Probe at least one child even at the boundary: a leaf is complete.
        self.node_limit
            .saturating_sub(self.seen.len() + self.pending.len())
            .min(self.child_limit)
            .max(1)
    }
    pub(crate) fn extend(
        &mut self,
        depth: usize,
        children: Vec<T>,
        more: bool,
        same: impl Fn(&T, &T) -> bool,
    ) {
        self.truncated |= more;
        for child in children {
            if self.seen.iter().any(|node| same(node, &child))
                || self.pending.iter().any(|(node, _)| same(node, &child))
            {
                continue;
            }
            if depth >= self.depth_limit || self.seen.len() + self.pending.len() >= self.node_limit
            {
                self.truncated = true;
                continue;
            }
            self.pending.push_back((child, depth + 1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn targeted_search_reaches_deep_controls_and_late_siblings() {
        let mut tree = WindowTraversal::new(0, true);
        let mut found = false;
        while let Some((node, depth)) = tree.next() {
            let children = if node == 0 {
                (1..=160).collect::<Vec<_>>()
            } else if (160..200).contains(&node) {
                vec![node + 1]
            } else {
                vec![]
            };
            assert!(children.len() <= tree.child_limit(depth));
            found |= node == 200;
            tree.extend(depth, children, false, PartialEq::eq);
        }
        assert!(found);
        assert!(!tree.truncated);
    }
    #[test]
    fn shared_nodes_and_cycles_do_not_exhaust_the_budget() {
        let mut tree = WindowTraversal::new(0, true);
        let mut visited = vec![];
        while let Some((node, depth)) = tree.next() {
            visited.push(node);
            let children = match node {
                0 => vec![0, 1, 1, 2],
                1 => vec![0, 2],
                _ => vec![1],
            };
            tree.extend(depth, children, false, PartialEq::eq);
        }
        assert_eq!(visited, [0, 1, 2]);
        assert!(!tree.truncated);
    }
    #[test]
    fn a_leaf_at_the_depth_boundary_is_complete_but_an_omitted_child_is_not() {
        for has_child in [false, true] {
            let mut tree = WindowTraversal::new(0, false);
            while let Some((node, depth)) = tree.next() {
                let children = if node < 12 || has_child {
                    vec![node + 1]
                } else {
                    vec![]
                };
                tree.extend(depth, children, false, PartialEq::eq);
            }
            assert_eq!(tree.truncated, has_child);
        }
    }
    #[test]
    fn actual_node_and_child_limits_still_report_incomplete() {
        let mut tree = WindowTraversal::new(0, true);
        let mut visited = 0;
        while let Some((node, depth)) = tree.next() {
            visited += 1;
            tree.extend(depth, vec![node + 1], false, PartialEq::eq);
        }
        assert_eq!(visited, 512);
        assert!(tree.truncated);
        let mut tree = WindowTraversal::new(0, false);
        tree.next();
        tree.extend(0, vec![1], true, PartialEq::eq);
        assert!(tree.truncated);
    }
}
