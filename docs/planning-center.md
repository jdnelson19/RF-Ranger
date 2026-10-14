# Planning Center integration (groundwork)

Goal: fill RF slots with the people scheduled for the next service, and show Services Live timers in the Engineer and Pickup views. When a service ends, move to the next one on its own.

**Status:** the API client, credentials, and data reads are built and tested against recorded response shapes. Nothing is wired into the runtime or UI yet. Use `npm run pco` to check that real data comes back as expected.

## Credentials (per user)

Planning Center uses a **Personal Access Token**: an Application ID plus a Secret, sent with HTTP Basic auth. Create one at <https://api.planningcenteronline.com/oauth/applications>. It acts as the person who created it, so it sees what they can see in Services.

Credentials are kept out of the show config on purpose, because configs get copied and shared. They're looked up in this order:

1. `PCO_APP_ID` and `PCO_SECRET` environment variables
2. `~/.rf-ranger/planning-center.json`, which `npm run pco -- setup` writes after checking the token works

RF Ranger only ever reads.

## Try it

```
cd server
npm run pco -- setup                 # paste Application ID and Secret
npm run pco -- types                 # service types and their IDs
npm run pco -- next "Sunday AM"      # upcoming plan + who's scheduled, by team/position
npm run pco -- live "Sunday AM"      # Services Live: current item, time left, next item
npm run pco -- watch "Sunday AM"     # the same, every 5 s (run during a service)
```

## What we read

| Need | Endpoint | Fields |
|---|---|---|
| Service types | `GET /services/v2/service_types` | `name` |
| Upcoming plan | `GET …/service_types/{id}/plans?filter=future&order=sort_date&include=plan_times` | `title`, `series_title`, `dates`, `sort_date`; plan times `starts_at`, `ends_at`, `time_type` |
| Who's scheduled | `GET …/plans/{id}/team_members?include=team` | `name`, `team_position_name`, `status` (C/U/D), `photo_thumbnail`, team `name` |
| Live timers | `GET …/plans/{id}/live?include=items,current_item_time` | current item time `live_start_at` → item `title`, `length` (s), `item_type` |

- **Rate limit:** 100 requests per 20 s per user. The client waits out `429` using `Retry-After`.
- **Rolling to the next service:** `upcomingPlan` stays on a plan until its *last service time* ends (rehearsals don't count), then returns the next plan. A runtime poller can call it every few minutes and swap assignments when the plan ID changes.
- **Repeated positions:** multiple people in the same team and position (three "BGV"s) are numbered 1, 2, 3 in Planning Center's order, the same way Companion does it. Mappings use that number.

## Next phase: mapping (not built)

A sketch, open for discussion:

```jsonc
"planningCenter": {
  "serviceType": "Sunday AM",          // name or ID
  "refreshMinutes": 5,
  "positions": [
    { "team": "Band", "position": "Worship Leader", "slot": 1 },
    { "team": "Band", "position": "BGV", "index": 1, "slot": 4 },
    { "team": "Band", "position": "BGV", "index": 2, "slot": 5 }
  ]
}
```

- A mapped slot takes `artist`, `role` (the position name) and `photo` (`photo_thumbnail`) from Planning Center. The equipment fields (`expectedTxId`, `charger`, `notes`) stay in config.
- Declined → slot shows SPARE. Unconfirmed → assigned, plus an engineer-facing info alert.
- If Planning Center is unreachable, keep the last good assignments and show a "Planning Center stale" banner to the engineer. Never blank the pickup display.
- Open question: when a person is scheduled in two mapped positions (e.g. Worship Leader and Acoustic Guitar), should they get both slots? Probably yes, since that's what the mapping says.

Live timers would add a `timer` block to the snapshot (`current`, `endsAt`, `next`). The UI counts down locally between polls, so the display ticks smoothly while polling every 5–10 s.

## Sources

- Planning Center API docs: <https://developer.planning.center/docs/#/apps/services>
- bitfocus `companion-module-planningcenter-serviceslive` (MIT, © 2018–2023 Joseph Adams). Its endpoint use and live-state handling were the cross-check here.
