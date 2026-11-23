use super::*;
use crate::{history::lineage, metadata::Guard};
use anyhow::bail;
#[derive(Debug)]
pub(super) struct Unrelated(&'static str);
impl std::fmt::Display for Unrelated {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Unrelated {}
impl Descendants {
    pub fn resolve(&self, input: Input, thread: JsString) -> Work<Value> {
        let generation = input.runtime.generation();
        let key = Value::Array(vec![
            s(input.chat_id.clone()),
            s(input.thread_id.clone()),
            s(thread.clone()),
            generation.clone().map_or(Value::Null, s),
            input.provenance.clone().unwrap_or(Value::Null),
        ])
        .stringify();
        let this = self.clone();
        let runtime = input.runtime.clone();
        let pending = self.0.resolutions.get(key, move || {
            cantrip_transport::lifecycle::owned(async move {
                this.verify(input, thread, generation).await
            })
        });
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let scope = pending.await?;
            this.0.signal.check()?;
            let capture = (this.0.options.bind)(Input {
                chat_id: scope["chatId"].as_js_string().unwrap().clone(),
                thread_id: scope["threadId"].as_js_string().unwrap().clone(),
                runtime,
                provenance: Some(scope["provenance"].clone()),
            })?;
            if let Some(reconcile) = capture {
                reconcile();
            }
            Ok(scope)
        })
    }
    fn check(&self, input: &Input, generation: &Option<JsString>) -> Result<()> {
        self.0.signal.check()?;
        if input.runtime.generation() != *generation {
            bail!("Native child discovery transport was replaced.");
        }
        Ok(())
    }
    async fn verify(
        &self,
        input: Input,
        thread: JsString,
        generation: Option<JsString>,
    ) -> Result<Value> {
        self.check(&input, &generation)?;
        let mut chain = Vec::new();
        let mut current = thread.clone();
        while current != input.thread_id {
            self.check(&input, &generation)?;
            if chain.contains(&current) || chain.len() >= 31 {
                return Err(
                    Unrelated("Native child discovery found an invalid parent chain.").into(),
                );
            }
            chain.push(current.clone());
            let snapshot = Guard::request(Some(self.0.signal.clone()))
                .run(input.runtime.read_history(current.clone()))
                .await?;
            self.check(&input, &generation)?;
            let child = lineage::child(&snapshot["thread"])
                .filter(|child| child["threadId"] == s(current.clone()))
                .ok_or(Unrelated(
                    "Native child discovery could not verify its parent.",
                ))?;
            current = child["parentThreadId"].as_js_string().unwrap().clone();
        }
        let mut binding = self
            .0
            .options
            .client
            .open(
                obj([
                    ("chatId", s(input.chat_id.clone())),
                    ("threadId", s(input.thread_id.clone())),
                    (
                        "provenance",
                        input
                            .provenance
                            .clone()
                            .unwrap_or_else(|| obj([("kind", s("current"))])),
                    ),
                ]),
                Some(self.0.signal.clone()),
            )
            .await?;
        self.check(&input, &generation)?;
        if binding["chatId"] != s(input.chat_id.clone())
            || binding["threadId"] != s(input.thread_id.clone())
        {
            bail!("Native child discovery received an unrelated root binding.");
        }
        for child in chain.into_iter().rev() {
            let provenance = obj([
                ("kind", s("child")),
                ("parentBindingId", binding["id"].clone()),
            ]);
            binding = self
                .0
                .options
                .client
                .open(
                    obj([
                        ("chatId", s(input.chat_id.clone())),
                        ("threadId", s(child.clone())),
                        ("provenance", provenance.clone()),
                    ]),
                    Some(self.0.signal.clone()),
                )
                .await?;
            self.check(&input, &generation)?;
            if binding["chatId"] != s(input.chat_id.clone())
                || binding["threadId"] != s(child.clone())
            {
                bail!("Native child discovery received an unrelated binding.");
            }
            (self.0.options.bind)(Input {
                chat_id: input.chat_id.clone(),
                thread_id: child,
                runtime: input.runtime.clone(),
                provenance: Some(provenance),
            })?;
        }
        Ok(obj([
            ("chatId", s(input.chat_id)),
            ("threadId", s(thread)),
            (
                "provenance",
                obj([("kind", s("binding")), ("bindingId", binding["id"].clone())]),
            ),
        ]))
    }
}
