# Planning Center integration

Goal: fill RF slots with the people scheduled for the next service, and show Services Live timers in the Engineer and Pickup views. When a service ends, move to the next one on its own.

**Status:**
- Each church links its own account in the app: **Engineer → Planning Center**. It shows the linked organization, the service type to follow, and the next service with its head count.
- Tested against a real account (Grace Church): 34 service types, and the next plan with 35 scheduled.
- **Mic assignments** (below) put scheduled people on mics, showing their name, position and photo on the engineer tiles and the pickup screen. **Services Live** (below) adds the live segment clock, the engineer LIVE banner and the leader highlight.

## Mic assignments

On **Engineer → Planning Center**:

**Services:** add each Planning Center service type you fill mics from with **Add a service**, for example a weekend service, a youth night and a midweek service in the same room. In Planning Center, teams and positions belong to a service type, so each service has its own mic rules, its own **Sync now** button and its own auto-sync.
- **Preferences** can name a mic, an IEM, or both ("Josh prefers RF1 · IEM 2"). A sync puts the person on their preferred IEM channel too, so it shows in their column on the pickup display.
- **Stars** on "Mics now" make one artist preset of the starred channels ("Synced mics" until renamed in the preset menu), with a button to show it on the pickup display. Unstarring the last channel deletes it. By default each sync stars exactly the mics it filled, so the preset follows the service; untick **Star the synced mics on each sync** to set stars only by hand.
- **A sync replaces every mic assignment:** mics it doesn't fill are cleared, including people an earlier sync of another service put there and names set by hand. So switching to another service never leaves the previous service's people on mics. People from other services' last syncs can still be put on a mic by hand.
- **Removing a service** deletes its rules. The mics it filled stay until they're changed or cleared.
- **Rules saved before services existed** become the first service, for the service type that was chosen then.

**Mic rules** (per service) are set up once:
1. **Teams:** pick the teams whose people use wireless, for example *Vocals*. Others, like *Band*, are ignored.
2. **Mics per position:** under each of the team's positions (*Worship Leader*, *BGV 1*, *BGV 2*, …), click the mics it uses, in the order to fill them. For example, Worship Leader gets RF1, RF2 and RF3, and BGV 1 gets RF5. The list includes every position the team has, scheduled this week or not.
3. **Preferred mics (optional):** inside a position, "Sam prefers RF1" puts Sam on RF1 whenever they're scheduled in that position. When they aren't, RF1 goes to the next person. A preference only applies to the position's own mics. The picker offers the team's members, plus anyone scheduled on the team at the last sync. Staff are often scheduled on a team without being listed as its members.

**Sync from Planning Center** applies the rules to the upcoming plan:
- **Order:** for each position, preferences go first. Everyone else gets the next free mic, in Planning Center's order.
- **Who's skipped:** people who declined are left out. Unconfirmed people get a mic, marked *unconfirmed*. Nobody is put on two mics.
- **No mic:** anyone left without one is listed, either because every mic for their role is taken or because the role has no mics.

**Changing it by hand:** each mic has a dropdown listing the people scheduled on the wireless teams, **Nobody**, or **Someone else…** for a name that isn't on the schedule.
- **Moving someone:** picking a person moves them from any other mic. Anyone bumped off a mic is listed under "No mic", so nobody drops off silently.
- **Edited mics:** these are tagged *edited*.
- **Syncing again:** this replaces the changes, after a confirmation.

**Where it shows:** the person's name, position and Planning Center photo appear on that channel's engineer tile and on the pickup screen. A mic with someone on it counts as assigned, so a mic that's switched off shows orange "Off", not "Spare". A preset nickname still wins on the engineer screen. Any charger bay and expected transmitter from a show config still apply.

**Storage and access:** the services, their rules and the current assignments are saved in `~/.rf-ranger/mic-assignments.json`, so a restart keeps them. Like the rest of this screen, they can only be changed on the computer running RF Ranger.

**Auto-sync** is set per service and is off by default. Several services can each sync on their own through the week. There are two kinds:
- **Before the next rehearsal or service:** a time between 15 minutes and 1 day before the first rehearsal or service time of the service's next plan, for example "2 hours before".
  - **Changes stay:** it syncs each plan once. A plan already synced, by hand or automatically, is never synced again on its own, so a tech can fix things at rehearsal and the changes stay for the service.
  - **Next plan:** once the plan's last service time has ended, the next plan gets its own sync.
  - **While RF Ranger is closed:** it catches up when RF Ranger next runs, as long as the service hasn't started.
- **Every week at a set time:** for example, every Wednesday at 5:00 PM, on the RF Ranger computer's clock. It syncs the service's upcoming plan at that time each week.
  - **New schedules:** a time that has already passed today waits for next week rather than running straight away.
  - **While RF Ranger is closed:** a time missed by less than 12 hours still runs when RF Ranger opens. Otherwise it waits for next week.

RF Ranger checks the schedules every minute, and each service's panel shows when its next sync will run.

## Services Live: clock, banner and leader

While a service is running in Planning Center's **Services Live**:
- **Pickup screen:** a **Now** strip shows the live segment, a countdown to its planned end, and what's next. The countdown turns orange in the last 30 seconds and counts up in red when over time.
- **Engineer view:** a **LIVE** banner shows the service, segment, time left, leader and next item.
- **Leader highlight:** each item's note in the **Leader** category ("Sam/BGVs/Band", "Pastor Alex Morgan") is matched against who is on each mic. Names can be full names, names after a title, or a first name nobody else on a mic shares. Matching mics are marked **Leading now** on both screens.

How it works:
- **When it watches:** from 30 minutes before a plan's first rehearsal or service time until 30 minutes after its last, RF Ranger reads Services Live every 5 seconds, for each set-up service. The first one that's running is shown. Outside those times, it checks each service's next plan once a minute.
- **Clock:** it runs on the server's clock, so a TV with the wrong time still counts down correctly.
- **Demo mode** plays a made-up running order instead.

Not yet:
- It doesn't write names back to the receivers.

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
