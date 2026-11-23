import assert from "node:assert/strict";
import path from "node:path";
import { postgresDeliveryFixture } from "./postgres-delivery-fixture.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
  until,
} from "./native-settings-http-fixture.mjs";
import {
  seedEventChats,
  prepareEventCommands,
} from "./native-event-http-setup.mjs";
import {
  eventContents,
  eventPrivateMarker,
} from "./native-event-http-content.mjs";

export async function nativeEventPublicationSchedules({
  pg,
  root,
  executable,
  repositoryExecutable,
  passwordHash,
  report,
  profiles = ["accounts"],
}) {
  const cases = (report.publicationSchedules = []);
  for (const profile of profiles) {
    for (const mode of ["commit-response", "notification"]) {
      const outputs = [];
      cases.push({ profile, mode, outputs });
      for (const kind of ["node", "rust"]) {
        const delivery = await postgresDeliveryFixture(await pg.database());
        let h, pending;
        const result = { kind, observations: [] };
        outputs.push(result);
        try {
          h = await settingsHttpFixture({
            kind,
            profile,
            root: path.join(root, "publication-schedules", mode),
            executable,
            repositoryExecutable,
            passwordHash,
            databaseMode: "postgres",
            url: delivery.url,
            result,
            configure: seedEventChats,
          });
          h.prepared = await prepareEventCommands(h);
          await h.live.subscribed("approval-schedule", [
            { kind: "chat", chatId: chat },
            { kind: "project", projectId: project },
            { kind: "current-user" },
          ]);
          const content = await eventContents(h);
          await h.live.ping("before-controlled-approval");
          const start = h.live.history.length;
          const events = () =>
            h.live.history.slice(start).filter((v) => v.type === "event");
          delivery.arm(mode);
          const operation = h.prepared[chat];
          pending = h.visit(
            "controlled encrypted approval",
            "POST",
            "/api/internal/native-commands/events",
            {
              client: "worker",
              headers: { authorization: "Bearer " + h.credential },
              json: {
                workerId: worker,
                operationId: operation.operationId,
                operationGeneration: operation.operationGeneration,
                event: {
                  type: "computer-use.approval.request",
                  operationId: content.computer.requestKey,
                  request: content.computer,
                },
              },
            },
          );
          // Keep a failed request handled while a socket deadline is pending.
          pending.catch(() => {});
          if (mode === "commit-response") {
            await h.live.message(
              (v) => v.type === "event" && v.resource === "project-alert",
            );
            assert.deepEqual(
              events().map((v) => v.resource),
              ["project-alert"],
              "commit result is still withheld",
            );
            assert.equal(
              delivery.observations.filter((v) => v.boundary === "commit-sent")
                .length,
              1,
            );
            delivery.release();
            assert.deepEqual(await pending, { applied: true });
            await h.live.message(
              (v) => v.type === "event" && v.resource === "chat",
            );
          } else {
            assert.deepEqual(await pending, { applied: true });
            await h.live.message(
              (v) => v.type === "event" && v.resource === "chat",
            );
            assert.deepEqual(
              events().map((v) => v.resource),
              ["agent-interaction", "chat"],
              "notification delivery is still withheld",
            );
            // Wait for the actual held frame, rather than assuming the database
            // listener has processed it because an HTTP or socket reply arrived.
            await until(
              () => delivery.observations,
              (v) =>
                v.some((x) => x.boundary === "alert-notification" && x.held),
            );
            assert.ok(
              delivery.release() > 0,
              "real notification frames released",
            );
            await h.live.message(
              (v) => v.type === "event" && v.resource === "project-alert",
            );
          }
          await h.live.ping("after-controlled-approval");
          const trace = events();
          assert.deepEqual(
            trace.map((v) => v.resource),
            mode === "commit-response"
              ? ["project-alert", "agent-interaction", "chat"]
              : ["agent-interaction", "chat", "project-alert"],
          );
          for (let i = 1; i < trace.length; i++)
            assert.ok(trace[i].cursor > trace[i - 1].cursor);
          const clean = trace.map(({ cursor, occurredAt, ...v }) => {
            assert.ok(
              Date.parse(occurredAt) >= Date.now() - 300000 &&
                Date.parse(occurredAt) <= Date.now() + 1000,
            );
            return v;
          });
          result.events = clean;
          result.rawEvents = trace;
          result.delivery = delivery.observations;
          assert.equal(
            JSON.stringify([trace, [...h.fixture.records.values()]]).includes(
              eventPrivateMarker,
            ),
            false,
          );
        } finally {
          result.delivery = delivery.observations;
          result.rawEvents ??= h?.live.history.filter(
            (v) => v.type === "event",
          );
          delivery.release();
          await pending?.catch(() => {});
          await h?.close();
          await delivery.close();
        }
      }
      assert.deepEqual(
        outputs[1].events,
        outputs[0].events,
        profile + " " + mode + " exact scheduled trace",
      );
    }
  }
}
