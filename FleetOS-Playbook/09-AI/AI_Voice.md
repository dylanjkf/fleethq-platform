# AI Voice

## Purpose
An operator in a moving or just-parked asset shouldn't need to touch a screen to log a fault, call dispatch, or move to the next step of their day. AI Voice makes core DriverOS actions available hands-free.

## Requirements
- Voice trigger (wake phrase or push-to-talk button) available within DriverOS.
- Supported v1 command set: "log damage," "call dispatch," "next stop," "open checklist," "log [fault type]," "read messages." Command set is extensible via configuration, not a hardcoded list requiring an app update per addition.
- Every voice command has an identical manual (touch) equivalent — voice is an alternate input method, never the only path to an action.
- Voice commands that create data (e.g. "log damage") open the relevant flow with the intent captured; they do not silently submit a completed action without the operator confirming what got logged, unless the command is a simple, low-risk navigation ("next stop").

## Workflows
- Operator: "Log damage" → DriverOS opens the damage-report flow pre-started, camera ready, with any implied context (current asset, current location) pre-filled → operator confirms/completes with photo.
- Operator: "Call dispatch" → initiates the configured contact method for dispatch without requiring the operator to find a contact in a phone app.

## Edge cases
- Noisy cab environment / misrecognition: must fail safely — ask for confirmation or clarification rather than executing a wrong action.
- No connectivity: voice commands that only need local data/actions (opening a checklist, logging a fault for later sync) must still work offline; commands requiring live connectivity (e.g. an actual phone call) should fail with a clear message, not hang.
- Operator privacy: microphone access must be clearly permissioned and only active during explicit voice-trigger use, never continuously listening/recording.

## Technical considerations
- Speech-to-intent resolution is a Fleet Intelligence capability; the underlying action execution (opening a form, starting a checklist) is the same code path as the manual/touch trigger — voice is a different entry point into identical business logic, not a parallel implementation.

## Acceptance criteria
- Every documented v1 voice command produces the identical end state as its manual equivalent.
- Voice commands function offline wherever their manual equivalents do.
- Misrecognized commands never execute a destructive or data-creating action without confirmation.

## Future expansion notes
- Expanding the command vocabulary and supporting more natural phrasing (rather than fixed command phrases) is expected to grow as the underlying NLP layer matures alongside Universal Search's natural-language resolution — the two capabilities should share the same intent-resolution engine over time.

## Implementation notes (v1, `apps/driveros`)
- **Speech-to-text is the browser's own native Web Speech API** (`SpeechRecognition`/`webkitSpeechRecognition`) — no backend call, no API key, no new infrastructure. This is real STT, not a stand-in for one; it's just running inside the browser Chrome/WebView already ships rather than a server FleetOS operates. Zero cost to this being unavailable: if the browser doesn't support it, the trigger button simply doesn't render (`isVoiceRecognitionSupported()`) and every existing tap-based path is completely unaffected — the fallback isn't a degraded voice mode, it's the app exactly as it was before this feature existed.
- **Push-to-talk, not a wake phrase** — the Requirements line offers either; a wake phrase needs continuous background audio processing, which conflicts harder with the privacy edge case ("only active during explicit voice-trigger use, never continuously listening") than a tap-to-start button does. `listenOnce()` uses `continuous: false`, so the mic closes itself the moment one utterance is captured (or on silence/error) — never left open.
- **All five v1 commands are built**, and all route into flows that already existed with a full manual/touch path — no new business logic, exactly this doc's own Technical Considerations line ("voice is a different entry point into identical business logic, not a parallel implementation"):
  - "log damage" / "log [fault type]" → generalized to any `"log "`/`"report "` prefix, with everything after it pre-filling (never auto-submitting) the Fault Report flow's title field.
  - "call dispatch" → the existing company-configured support phone (`01-Product/Support_Help_Pathway.md`), via the same `tel:` link `HelpPage.tsx` already ships; a clear message if no number is configured, never a hang.
  - "next stop" → the operator's current job's next pending stop, the same computation `TodayPage` already does.
  - "open checklist" → the Smart Checklist flow for the operator's current job's asset.
  - "read messages" → genuinely voice-only, not a tap shortcut: speaks the latest office message aloud via `speechSynthesis` (also native, no backend), then opens Messages for visual follow-up.
- **Intent resolution is keyword matching, not an LLM call** — the same "deterministic core before any AI enhancement" reasoning this codebase already applied to Fatigue and Predictive Maintenance. An unmatched transcript never guesses; it shows exactly what was heard and lists the real commands to try, satisfying the acceptance criterion that misrecognition never executes an action without confirmation. The command list is a single array in `lib/voice-commands.ts` — "extensible via configuration" only in the sense that it's one editable file, not scattered through screens; it is **not** yet a server-driven, company-editable list (a real gap against the Requirements line, flagged rather than silently glossed over).
- **Global, not Today-only** — rendered once from `ProtectedRoute` (wrapping every authenticated screen's `<Outlet>`), so it's available "within DriverOS" as a whole per the Purpose statement, not just from the home screen.
- **Deliberately not built**: fuzzy/natural phrasing beyond the fixed keyword list (explicitly named as future work by this doc's own Future expansion notes) — and this environment cannot verify real speech recognition end-to-end at all (no microphone/audio hardware in this sandbox). What *is* verified, live, in a real browser: the full pipeline from trigger press through to the correct navigation/action for every one of the five documented commands, by substituting a scripted fake `SpeechRecognition` at the Web API boundary (the same "inject at the external-dependency boundary" principle e2e tests already use for third-party services) — genuine confidence in everything this codebase controls, honest silence on the one thing it can't: whether Chrome's own speech engine transcribes a given voice accurately, which is Google's concern, not FleetOS's.
- **Offline nuance**: the *actions* behind next-stop/open-checklist/log-fault all reuse `getTodayJobs`'s existing offline-cache fallback, so they work offline exactly as their tap equivalents do. Voice *input* itself is a separate question — most browsers' `SpeechRecognition` implementations depend on a cloud recognition service, so the transcription step itself may need connectivity even though the resulting action wouldn't. This is a real, inherent constraint of the browser API in use, not a FleetOS shortcut, and is called out here rather than glossed over.
