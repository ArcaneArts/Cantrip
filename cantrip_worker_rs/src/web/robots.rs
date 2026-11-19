use super::network::{Limits, Network, follow};
use anyhow::{Context, Result, ensure};
use cantrip_wire::text;
use indexmap::IndexMap;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{Instant, timeout};
use url::Url;

const LIMIT: usize = 512_000;
const MAX_ORIGINS: usize = 500;
const TTL: Duration = Duration::from_secs(600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const LIMITS: Limits = Limits {
    compressed: LIMIT,
    expanded: LIMIT,
    types: &["text/plain", "text/html"],
};

#[derive(Default)]
pub(super) struct Robots(Mutex<IndexMap<String, Cached>>);

struct Cached {
    expires: Instant,
    rules: Arc<Vec<Rule>>,
}

struct Rule {
    allow: bool,
    pattern: String,
    length: usize,
}

impl Robots {
    pub(super) async fn check(&self, network: &Network, url: &Url) -> Result<()> {
        let origin = url.origin().ascii_serialization();
        let rules = self
            .0
            .lock()
            .unwrap()
            .get(&origin)
            .filter(|cached| cached.expires > Instant::now())
            .map(|cached| cached.rules.clone());
        let rules = match rules {
            Some(rules) => rules,
            None => {
                let robots_url = url.join("/robots.txt")?;
                let page = timeout(
                    FETCH_TIMEOUT,
                    follow(robots_url, |url| network.get(url, &LIMITS)),
                )
                .await
                .context("The site's robots policy request timed out.")??;
                ensure!(
                    !matches!(page.status, 401 | 403),
                    "The site's robots policy does not allow autonomous reading."
                );
                ensure!(
                    page.status < 500,
                    "The site's robots policy is temporarily unavailable."
                );
                let rules = Arc::new(if (200..300).contains(&page.status) {
                    parse(&String::from_utf8_lossy(&page.bytes))
                } else {
                    Vec::new()
                });
                let mut cache = self.0.lock().unwrap();
                let now = Instant::now();
                cache.retain(|_, cached| cached.expires > now);
                cache.insert(
                    origin,
                    Cached {
                        expires: now + TTL,
                        rules: rules.clone(),
                    },
                );
                if cache.len() > MAX_ORIGINS {
                    cache.shift_remove_index(0);
                }
                rules
            }
        };
        let candidate = &url[url::Position::BeforePath..url::Position::AfterQuery];
        ensure!(
            allows(&rules, candidate),
            "The site's robots policy does not allow autonomous reading of this URL."
        );
        Ok(())
    }
}

#[derive(Default)]
struct Group {
    cantrip: bool,
    wildcard: bool,
    saw_rule: bool,
    rules: Vec<Rule>,
}

fn parse(contents: &str) -> Vec<Rule> {
    let mut groups: Vec<Group> = Vec::new();
    for raw in contents.lines() {
        let field = raw.split('#').next().unwrap();
        let Some((key, value)) = field.split_once(':') else {
            continue;
        };
        let key = text::trim(key);
        let value = text::trim(value);
        if key.eq_ignore_ascii_case("user-agent") {
            if groups.last().is_none_or(|group| group.saw_rule) {
                groups.push(Group::default());
            }
            let group = groups.last_mut().unwrap();
            group.cantrip |= value.eq_ignore_ascii_case("cantripresearchbot");
            group.wildcard |= value == "*";
        } else if let Some(group) = groups.last_mut() {
            let allow = key.eq_ignore_ascii_case("allow");
            if allow || key.eq_ignore_ascii_case("disallow") {
                group.saw_rule = true;
                if !value.is_empty() {
                    group.rules.push(Rule {
                        allow,
                        pattern: value.to_owned(),
                        length: text::length(value),
                    });
                }
            }
        }
    }
    let cantrip = groups.iter().any(|group| group.cantrip);
    groups
        .into_iter()
        .filter(|group| {
            if cantrip {
                group.cantrip
            } else {
                group.wildcard
            }
        })
        .flat_map(|group| group.rules)
        .collect()
}

fn matches(path: &str, pattern: &str) -> bool {
    let exact = pattern.strip_suffix('$');
    let pattern = exact.unwrap_or(pattern);
    let Some((first, rest)) = pattern.split_once('*') else {
        return if exact.is_some() {
            path == pattern
        } else {
            path.starts_with(pattern)
        };
    };
    let Some(mut path) = path.strip_prefix(first) else {
        return false;
    };
    let mut middle = rest;
    if exact.is_some() {
        let (inside, last) = rest.rsplit_once('*').unwrap_or(("", rest));
        let Some(prefix) = path.strip_suffix(last) else {
            return false;
        };
        path = prefix;
        middle = inside;
    }
    // Earliest matches leave the most room for the remaining literal segments.
    for part in middle.split('*').filter(|part| !part.is_empty()) {
        let Some((_, remaining)) = path.split_once(part) else {
            return false;
        };
        path = remaining;
    }
    true
}

fn allows(rules: &[Rule], path: &str) -> bool {
    rules
        .iter()
        .filter(|rule| matches(path, &rule.pattern))
        .max_by_key(|rule| (rule.length, rule.allow))
        .is_none_or(|rule| rule.allow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specific_groups_and_longest_rules_match_the_reference() {
        let rules = parse(
            "User-Agent: *\nDisallow: /\nUser-Agent: CantripResearchBot\nUser-Agent: Other\nDisallow: /files/*?private=*$\nAllow: /files/public?private=1$\nDisallow: /tie\nAllow: /tie\nUser-Agent: CantripResearchBot\nDisallow: /private\n",
        );
        assert!(allows(&rules, "/"));
        assert!(allows(&rules, "/tie"));
        assert!(allows(&rules, "/files/public?private=1"));
        assert!(!allows(&rules, "/files/a/b?private=1"));
        assert!(!allows(&rules, "/private/x"));
        assert!(!matches("aba", "ab*ba$"));
        assert!(matches("abba", "ab*ba$"));
        assert!(matches("/x", "*$"));
        assert!(matches("/abc/mn/abc", "/*abc*abc$"));
    }
}
