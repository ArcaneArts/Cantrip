use crate::wire::Value;

// The protocol currently has one target. Keep its user-visible mappings equal
// to the Source service; exporting a worktree never copies its files.
pub fn mappings() -> Value {
    Value::from_serialize(&serde_json::json!({
        "targetLabel":"Codex", "maxChats":20, "supportedChatExperiences":["agent"],
        "preserves":[
            {"id":"project-folder","label":"Project folder","description":"The selected Cantrip worktree becomes the Codex thread workspace; project files are not copied."},
            {"id":"chat-title","label":"Chat titles","description":"Each selected chat keeps its current title."},
            {"id":"chat-messages","label":"Conversation","description":"User and assistant messages become native, discoverable Codex turns."}
        ],
        "flattens":[
            {"id":"developer-messages","label":"Developer messages","description":"Developer messages keep their content and order as explicit annotations in native Codex user turns."},
            {"id":"activities","label":"Tool and agent activity","description":"Supported activity is converted to compact text annotations inside the transcript."},
            {"id":"attachments","label":"Attachments","description":"Attachment references are retained as text; attachment files are not copied in this first version."},
            {"id":"cantrip-metadata","label":"Cantrip-only state","description":"Workers, routes, credentials, tasks, schedules, approvals, goals, and managed tools are omitted."}
        ]
    }))
}
