use crate::{chats::agent_delivery::DeliveryError, database::Transaction, wire::Value};
use anyhow::{Context, Result};

const MAX_DEPTH: i32 = 12;
const MAX_DELIVERIES: i32 = 32;

pub(super) struct Lineage {
    pub chain: String,
    pub depth: i32,
    pub sender_input: Option<String>,
}

pub(super) async fn admit(
    tx: &Transaction<'_>,
    owner: &str,
    sender: &str,
    source: &Value,
    operation: &str,
) -> Result<Lineage> {
    let lane = source["executionLaneId"]
        .as_str()
        .context("Council execution lane")?;
    // Take parent identity from the admitted root or a proven steer consumed by
    // its active generation. A prior turn in the same chat cannot supply it.
    let rows = tx.query(
        r#"WITH active AS (
            SELECT a.generation,root.operation_id,root.logical_client_message_id
            FROM native_command_activations a
            JOIN native_commands current_command ON current_command.operation_id=a.operation_id
            JOIN native_commands root ON root.operation_id=coalesce(current_command.logical_operation_id,current_command.operation_id)
            WHERE a.chat_id=$2 AND a.active AND a.execution_lane_id=$3
              AND root.chat_id=a.chat_id AND root.owner_id=$1
        ), incoming AS (
            SELECT d.chain_id,d.depth,d.created_at,d.input_message_id
            FROM active a JOIN council_peer_deliveries d
              ON d.input_message_id=a.logical_client_message_id AND d.recipient_chat_id=$2
            WHERE d.chain_id IS NOT NULL
            UNION ALL
            SELECT d.chain_id,d.depth,d.created_at,d.input_message_id
            FROM active a JOIN native_commands steer
              ON steer.activation_generation=a.generation AND steer.chat_id=$2 AND steer.owner_id=$1
            JOIN managed_queue_claims q
              ON q.operation_id=steer.operation_id AND q.operation_generation=steer.operation_generation
            JOIN council_peer_deliveries d ON d.queued_prompt_id=q.prompt_id AND d.recipient_chat_id=$2
            WHERE steer.method='turn/steer' AND steer.status='applied' AND q.status='consumed'
              AND d.chain_id IS NOT NULL
        )
        SELECT a.operation_id,a.logical_client_message_id,p.chain_id,coalesce(p.depth,0)
        FROM active a LEFT JOIN LATERAL (
            SELECT chain_id,depth FROM incoming ORDER BY depth DESC,created_at DESC,input_message_id DESC LIMIT 1
        ) p ON true"#,
        &[&owner, &sender, &lane],
    ).await?;
    let lineage = if let Some(row) = rows.first() {
        let root: &str = row.get(0)?;
        let chain = row
            .get::<Option<String>>(2)?
            .unwrap_or_else(|| format!("turn:{root}"));
        let depth = row.get::<i32>(3)? + 1;
        Lineage {
            chain,
            depth,
            sender_input: row.get(1)?,
        }
    } else {
        Lineage {
            chain: format!("handoff:{sender}:{operation}"),
            depth: 1,
            sender_input: None,
        }
    };
    if lineage.depth > MAX_DEPTH {
        return Err(DeliveryError::PeerChainLimit.into());
    }
    let accepted = tx
        .query(
            "INSERT INTO council_peer_chains AS chain (id,owner_id,accepted) VALUES($1,$2,1)
         ON CONFLICT(id) DO UPDATE SET accepted=chain.accepted+1
         WHERE chain.owner_id=excluded.owner_id AND chain.accepted<$3 RETURNING id",
            &[&lineage.chain, &owner, &MAX_DELIVERIES],
        )
        .await?;
    if accepted.is_empty() {
        return Err(DeliveryError::PeerChainLimit.into());
    }
    Ok(lineage)
}
