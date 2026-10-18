# Planning Center integration

Goal: fill RF slots with the people scheduled for the next service, and show Services Live timers in the Engineer and Pickup views. When a service ends, move to the next one on its own.

**Status:**
- Each church links its own account in the app: **Engineer → Planning Center**. It shows the linked organization, the service type to follow, and the next service with its head count.
- Tested against a real account (Grace Church): 34 service types, and the next plan with 35 scheduled.
- Positions are not yet mapped to RF slots. That's next.

## Linking an account (each church, in the app)

Open **Engineer → Planning Center** on the computer running RF Ranger, then:
1. Paste a Personal Access Token and click **Connect**. The screen links to where to create one.
2. Choose the service type to follow.
3. Check the summary of the next service.

The screen only works on that computer, like the Device Inspector: a token is as good as a password.

- **Token handling.** RF Ranger checks a token with Planning Center *before* saving it, so a rejected token is never written to disk. The secret is never sent back to the browser; the screen shows only the organization's name and the token's last four characters.
- **Service types are chosen by ID.** Names repeat: one account has two different "Special Services".
- **Switching accounts.** The chosen service type is recorded with the organization it belongs to. Linking a different account clears it, because another account's IDs mean nothing.
- **Disconnect** deletes the token and choices from this computer.
- **A saved link is re-checked at startup**, in the background, so startup never waits on it.
- **Each request to Planning Center gives up after 15 seconds.** A network that accepts the connection and then stalls, such as a filter or proxy, used to leave the screen on "Loading…" for minutes. Now the screen says Planning Center didn't answer and offers **Try again**.
- **Failures go to the log** (on the Mac, `~/Library/Logs/RF Ranger/rf-ranger.log`) as lines starting `Planning Center`. A successful startup check logs `Planning Center: <church name>`. The token is never logged.

The code is in `server/src/integrations/planning-center/link.ts` (connection), `server/src/server/pco-http.ts` (local-only API) and `web/src/views/PlanningCenter.tsx` (screen).

### Sign in with Planning Center (planned)

Pasting a token works for everyone today, but the token belongs to one person's account. A one-click **Sign in with Planning Center** is the better long-term experience. Planning Center supports it for apps installed on a church's own computer: OAuth for **public** apps, which have no client secret and must use PKCE.
- Endpoints: `https://api.planningcenteronline.com/oauth/authorize` and `/oauth/token`.
- The scope needed is `services`.
- Access tokens last 2 hours. Refresh tokens are honored for 90 days, so a church that doesn't open RF Ranger for 90 days would sign in again.
- Since March 2023, only **Organization Administrators** can create OAuth applications.

Still to test with a registered app:
1. Whether `http://localhost:<port>` is accepted as the redirect URI.
2. Whether users of *other* organizations can authorize an app registered by one organization. This is the multi-church case.

The plan is to register the app in one Planning Center account, then sign in from a different church's account. The sign-in would slot into the same connection and screen as the token.

## Credentials (per user)

Planning Center uses a **Personal Access Token**: an Application ID plus a Secret, sent with HTTP Basic auth. Create one at <https://api.planningcenteronline.com/oauth/applications>. It acts as the person who created it, so it sees what they can see in Services.

Credentials are kept out of the show config on purpose, because configs get copied and shared. They're looked up in this order:

1. `PCO_APP_ID` and `PCO_SECRET` environment variables. The app shows these, but can't change or remove them.
2. `~/.rf-ranger/planning-center.json`, written by the app's Connect screen or by `npm run pco -- setup`, after the token has been checked.

Non-secret choices (organization, service type) are kept in `~/.rf-ranger/planning-center.settings.json`.

RF Ranger only ever reads.

## Command-line check

On Windows PowerShell, if `npm` is blocked by the script policy, use `npm.cmd` instead. Without the `--`, npm still passes arguments through: `npm.cmd run pco types`.

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
