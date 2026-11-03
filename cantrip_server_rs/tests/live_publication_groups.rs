use cantrip_server::{
    live::{Hub, Options},
    wire::Value,
};
use std::sync::{Arc, Barrier};

fn publication(resource: &str, entity: &str) -> Value {
    Value::from_serialize(&serde_json::json!({
        "ownerId":"owner",
        "scope":{"kind":"current-user"},
        "resource":resource,
        "action":"invalidated",
        "entityId":entity,
        "revision":Value::Null,
        "payload":Value::Null,
    }))
}

#[tokio::test]
async fn synchronous_groups_stay_contiguous_with_concurrent_notification_producers() {
    let hub = Hub::new(Options::default()).unwrap();
    let start = Arc::new(Barrier::new(9));
    let mut producers = Vec::new();
    for worker in 0..8 {
        let (hub, start) = (hub.clone(), start.clone());
        producers.push(std::thread::spawn(move || {
            start.wait();
            for operation in 0..128 {
                let entity = format!("{worker}-{operation}");
                let events = hub
                    .publish_group(vec![
                        publication("agent-interaction", &entity),
                        publication("chat", &entity),
                    ])
                    .unwrap();
                assert_eq!(events.len(), 2);
                assert_eq!(events[0]["resource"], "agent-interaction");
                assert_eq!(events[1]["resource"], "chat");
                assert_eq!(events[0]["entityId"], events[1]["entityId"]);
                assert_eq!(
                    events[1]["cursor"].as_u64().unwrap(),
                    events[0]["cursor"].as_u64().unwrap() + 1,
                    "an independent producer must not split the handler's group",
                );
            }
        }));
    }
    start.wait();
    for operation in 0..1024 {
        hub.publish(publication("project-alert", &operation.to_string()))
            .unwrap();
    }
    for producer in producers {
        producer.join().unwrap();
    }
    let event = hub.publish(publication("chat", "last")).unwrap();
    assert_eq!(event["cursor"].as_u64(), Some(3073));
    hub.close();
}
