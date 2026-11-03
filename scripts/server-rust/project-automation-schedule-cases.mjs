export function projectAutomationScheduleCases() {
  const rows = [];
  const zones = [
    "UTC",
    "America/New_York",
    "Europe/Berlin",
    "Australia/Lord_Howe",
    "Pacific/Apia",
    "Asia/Kathmandu",
    "US/Pacific",
    "america/new_york",
    "+05:30",
    "-08:00",
    "Etc/GMT+8",
    "US/Pacific-New",
    "SystemV/AST4",
    "SystemV/AST4ADT",
    "SystemV/CST6",
    "SystemV/CST6CDT",
    "SystemV/EST5",
    "SystemV/EST5EDT",
    "SystemV/HST10",
    "SystemV/MST7",
    "SystemV/MST7MDT",
    "SystemV/PST8",
    "SystemV/PST8PDT",
    "SystemV/YST9",
    "SystemV/YST9YDT",
  ];
  const dates = [
    "2026-03-08T06:50:00Z",
    "2026-03-08T07:20:00Z",
    "2026-11-01T05:40:00Z",
    "2026-11-01T06:20:00Z",
    "2026-10-25T00:45:00Z",
    "2011-12-29T22:00:00Z",
    "2026-10-03T15:20:00Z",
    "2024-02-28T23:59:59Z",
    "0098-01-31T23:59:59.999Z",
    "2999-12-30T23:59:59.999Z",
    "3000-01-01T00:00:00Z",
    "2026-04-04T14:59:59.999Z",
    "2026-04-04T15:15:00.001Z",
    "1974-01-06T06:50:00Z",
    "1974-11-24T05:30:00Z",
    "1975-02-23T06:50:00Z",
    "2400-04-24T00:00:00Z",
    "2400-07-01T12:00:00Z",
  ];
  const expressions = [
    "* * * * *",
    "30 2 * * *",
    "30 1 * * *",
    "0 0 L * *",
    "0 0 15W * *",
    "0 0 * * MON#2",
    "0 0 * * FRI#L",
    "0 0 31 2 *",
    "@daily",
    "0 0 * JAN,MAR SUN",
    "*/15 1-4 * * *",
    "0 0 1 * +MON",
    "0 0 L,1W * *",
    "0 0 LW * *",
    "0 0 31W * *",
    "0 0 ? * MON",
    "? ? * * *",
    "0 0 * ? ?",
    "0 0 * * 5L",
    "0 0 * * MON#1,FRI#L",
    "2026-11-04T05:00:00Z",
    "2026-11-04T05:00:00.999Z",
    "2026-11-04T05:00:00",
    "2026-11-04 05:00:00",
    "2026-02-31T05:00:00Z",
    "2026-11-04T05:00:00+05:30",
    "Wed, 04 Nov 2026 05:00:00 GMT",
    "Wed, 04 Nov 2026 05:00:00 GMT (\ud800)",
    "Wed, 04 Nov 2026 05:00:00 GMT (\udfff)",
    "Wed, 04 Nov 2026 05:00:00 GMT (emoji 🦀)",
  ];
  for (const timeZone of zones)
    for (const date of dates) {
      for (const expression of expressions)
        rows.push({
          schedule: { kind: "cron", expression, timeZone },
          afterMs: Date.parse(date),
        });
      for (const first of [false, true])
        rows.push({
          schedule: {
            kind: "weekly",
            weekdays: [1, 0, 1, 5, 5],
            hour: 1,
            minute: 30,
            timeZone,
          },
          afterMs: Date.parse(date),
          first,
        });
    }
  for (const startsAt of [
    "0000-02-29T12:34:56.789Z",
    "0098-01-31T23:59:59.999Z",
    "0099-12-31T00:00:00.001Z",
    "1900-01-31T12:34:56.789Z",
    "2000-02-29T12:34:56.789Z",
    "2026-01-31T23:59:59.999Z",
    "9999-12-31T23:59:59.999Z",
  ]) {
    const start = Date.parse(startsAt);
    for (const unit of ["minute", "hour", "day", "week", "month", "year"])
      for (const every of [1, 2, 13, 1000000])
        for (const afterMs of [
          start - 1,
          start,
          start + 1,
          start + 31 * 86400000,
          start + 366 * 86400000,
          8640000000000000 - 1,
        ])
          for (const first of [false, true])
            rows.push({
              schedule: { kind: "interval", unit, every, startsAt },
              afterMs,
              first,
            });
  }
  for (const timeZone of Intl.supportedValuesOf("timeZone"))
    for (const date of ["2026-03-28T22:30:00Z", "2026-10-31T22:30:00Z"])
      rows.push({
        schedule: { kind: "cron", expression: "30 2 * * *", timeZone },
        afterMs: Date.parse(date),
      });
  return rows;
}
