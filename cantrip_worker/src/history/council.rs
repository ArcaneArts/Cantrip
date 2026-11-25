mod document;

use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
pub(crate) use document::{Document, Link, bounded_text};
use indexmap::IndexMap;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as AsyncMutex;

type Slot = Arc<AsyncMutex<Option<Index>>>;
type Identity = (JsString, JsString);

#[derive(Default)]
pub(crate) struct Cache(Mutex<IndexMap<(Identity, JsString), Slot>>);

impl Cache {
    pub fn for_agent(&self, identity: &Identity, agent: &JsString) -> Slot {
        let key = (identity.clone(), agent.clone());
        let mut indexes = self.0.lock().unwrap();
        indexes.retain(|(owner, _), _| owner == identity);
        let slot = indexes.shift_remove(&key).unwrap_or_default();
        indexes.insert(key, slot.clone());
        if indexes.len() > 2 {
            indexes.shift_remove_index(0);
        }
        slot
    }
}

pub(crate) struct Index {
    pub revision: i64,
    pub through_sequence: i64,
    unavailable: HashSet<String>,
    pub documents: usize,
    db: Connection,
}

pub(crate) struct Projection {
    pub id: String,
    pub document: Option<Document>,
    pub unavailable: bool,
}

impl Index {
    pub fn new(revision: i64) -> Result<Self> {
        let db = Connection::open_in_memory()?;
        db.execute_batch("PRAGMA temp_store=MEMORY;
            CREATE TABLE documents (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL, source TEXT NOT NULL, time TEXT NOT NULL, body TEXT NOT NULL);
            CREATE VIRTUAL TABLE terms USING fts5(body, content=documents, content_rowid=sequence, tokenize='unicode61');
            CREATE VIRTUAL TABLE literals USING fts5(body, content=documents, content_rowid=sequence, tokenize='trigram');")?;
        Ok(Self {
            revision,
            through_sequence: 0,
            unavailable: HashSet::new(),
            documents: 0,
            db,
        })
    }

    pub fn apply(&mut self, projections: &[Projection], replace: bool) -> Result<()> {
        let tx = self.db.transaction()?;
        let (inserted, removed) = write(&tx, projections, replace)?;
        tx.commit()?;
        self.documents = self.documents + inserted - removed;
        for projection in projections {
            if projection.unavailable {
                self.unavailable.insert(projection.id.clone());
            } else {
                self.unavailable.remove(&projection.id);
            }
        }
        Ok(())
    }

    pub fn unavailable(&self) -> usize {
        self.unavailable.len()
    }

    pub fn search(
        &self,
        link: &Link<'_>,
        query: &str,
        exact: bool,
        limit: usize,
    ) -> Result<Vec<Value>> {
        if exact && query.chars().count() < 3 {
            return self.short_literal(link, query, limit);
        }
        let quote = |part: &str| format!("\"{}\"", part.replace('"', "\"\""));
        let (index, expression) = if exact {
            ("literals", quote(query))
        } else {
            (
                "terms",
                query
                    .split_whitespace()
                    .take(32)
                    .map(quote)
                    .collect::<Vec<_>>()
                    .join(" AND "),
            )
        };
        let excerpt = if exact {
            "d.body"
        } else {
            "snippet(terms,0,'','',' … ',28)"
        };
        let mut stmt = self.db.prepare(&format!(
            "SELECT d.sequence,d.id,d.role,d.source,d.time,{excerpt}
            FROM {index} JOIN documents d ON d.sequence={index}.rowid
            WHERE {index} MATCH ?1 ORDER BY rank,d.sequence DESC LIMIT ?2"
        ))?;
        let limit = i64::try_from(limit)?;
        let items = stmt.query_map(params![expression, limit], |row| {
            evidence(row, link, exact.then_some(query))
        })?;
        Ok(items.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn short_literal(&self, link: &Link<'_>, query: &str, limit: usize) -> Result<Vec<Value>> {
        let query = query.to_lowercase();
        let mut stmt = self.db.prepare(
            "SELECT sequence,id,role,source,time,body FROM documents ORDER BY sequence DESC",
        )?;
        let mut rows = stmt.query([])?;
        let mut items = Vec::new();
        while items.len() < limit {
            let Some(row) = rows.next()? else { break };
            let body = row.get_ref(5)?.as_str()?;
            if body.to_lowercase().contains(&query) {
                items.push(evidence(row, link, Some(&query))?);
            }
        }
        Ok(items)
    }
}

fn write(
    tx: &Transaction<'_>,
    projections: &[Projection],
    replace: bool,
) -> Result<(usize, usize)> {
    let mut lookup = tx.prepare("SELECT sequence,body FROM documents WHERE id=?1")?;
    let mut delete = tx.prepare("DELETE FROM documents WHERE id=?1")?;
    let mut delete_terms =
        tx.prepare("INSERT INTO terms(terms,rowid,body) VALUES('delete',?1,?2)")?;
    let mut delete_literals =
        tx.prepare("INSERT INTO literals(literals,rowid,body) VALUES('delete',?1,?2)")?;
    let mut append = tx.prepare("INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6)")?;
    let mut terms = tx.prepare("INSERT INTO terms(rowid,body) VALUES(?1,?2)")?;
    let mut literals = tx.prepare("INSERT INTO literals(rowid,body) VALUES(?1,?2)")?;
    let (mut inserted, mut removed) = (0, 0);
    for projection in projections {
        if replace
            && let Some((sequence, body)) = lookup
                .query_row([&projection.id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .optional()?
        {
            delete_terms.execute(params![sequence, body])?;
            delete_literals.execute(params![sequence, body])?;
            removed += delete.execute([&projection.id])?;
        }
        let Some(doc) = &projection.document else {
            continue;
        };
        append.execute(params![
            doc.sequence,
            doc.id,
            doc.role,
            doc.source,
            doc.created_at,
            doc.text
        ])?;
        terms.execute(params![doc.sequence, doc.text])?;
        literals.execute(params![doc.sequence, doc.text])?;
        inserted += 1;
    }
    Ok((inserted, removed))
}

fn evidence(
    row: &rusqlite::Row<'_>,
    link: &Link<'_>,
    exact: Option<&str>,
) -> rusqlite::Result<Value> {
    let id = row.get_ref(1)?.as_str()?;
    let mut result = link.evidence(
        id,
        row.get(0)?,
        row.get_ref(2)?.as_str()?,
        row.get_ref(3)?.as_str()?,
        row.get_ref(4)?.as_str()?,
    );
    let text = row.get_ref(5)?.as_str()?;
    let excerpt = exact
        .and_then(|needle| literal_start(text, needle))
        .map_or(text, |start| {
            let context = text[..start]
                .char_indices()
                .rev()
                .nth(59)
                .map_or(0, |(offset, _)| offset);
            &text[context..]
        });
    result["snippet"] = json!(bounded_text(excerpt, 600));
    Ok(result)
}

fn literal_start(text: &str, needle: &str) -> Option<usize> {
    text.find(needle).or_else(|| {
        let target = text.to_lowercase().find(&needle.to_lowercase())?;
        let mut folded_offset = 0;
        for (offset, character) in text.char_indices() {
            folded_offset += character.to_lowercase().map(char::len_utf8).sum::<usize>();
            if target < folded_offset {
                return Some(offset);
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn indexes_fifty_thousand_messages_and_removes_redacted_text() -> Result<()> {
        let link = Link("95c932a6-3e83-48c8-846b-3d1d89b8eae4");
        let exact = "src/queue.rs:118 E_REPLICA_STALE";
        let marker = "Cutover failed because warm standby could not replay the write cursor.";
        let start = Instant::now();
        let mut index = Index::new(0)?;
        for offset in (0..50_000).step_by(256) {
            let records = (offset + 1..=(offset + 256).min(50_000))
                .map(|sequence| {
                    let id = format!("record-{sequence}");
                    let text = match sequence {
                        222 => format!("Original status contained {exact}"),
                        444 => marker.into(),
                        _ => "The project checked the worker status and summarized the next pass."
                            .repeat(5),
                    };
                    Projection {
                        id: id.clone(),
                        unavailable: false,
                        document: Some(Document {
                            id,
                            sequence,
                            role: "assistant".into(),
                            source: "message",
                            text,
                            attachments: vec![],
                            truncated: false,
                            created_at: "2026-11-25T00:01:00.000Z".into(),
                        }),
                    }
                })
                .collect::<Vec<_>>();
            index.apply(&records, false)?;
        }
        let rebuilt = start.elapsed();
        assert_eq!(index.documents, 50_000);
        let searching = Instant::now();
        assert_eq!(
            index.search(&link, exact, true, 10)?[0]["messageId"],
            "record-222"
        );
        assert_eq!(
            index.search(&link, "standby cutover write", false, 10)?[0]["messageId"],
            "record-444"
        );
        let search = searching.elapsed();
        let deleting = Instant::now();
        index.apply(
            &[Projection {
                id: "record-222".into(),
                document: None,
                unavailable: false,
            }],
            true,
        )?;
        let deletion = deleting.elapsed();
        assert_eq!(index.documents, 49_999);
        assert!(index.search(&link, exact, true, 10)?.is_empty());
        println!(
            "Council history 50000 messages, rebuild {rebuilt:?}, two searches {search:?}, one deletion {deletion:?}"
        );
        Ok(())
    }
}
