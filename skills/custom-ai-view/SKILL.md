---
name: custom-ai-view
description: Drive Custom AI View — a real browser inside pixel-accurate device frames, over MCP. Use when checking how a page looks or behaves on a phone, tablet or laptop; when a screenshot of a real device frame is wanted; when inspecting an element's markup, computed styles or box on a device; when reproducing a mobile-only bug; or when the user says "check this on iPhone / on mobile / on an iPad", "how does this look on a phone", "screenshot the device", "посмотри на телефоне", "проверь на айфоне".
---

# Custom AI View

A real browser running inside device frames built from published millimetre
dimensions, with an MCP server that lets you drive the same window the person is
looking at. Every tool takes an optional `window` argument, so two devices can be
driven side by side.

Nothing here is a re-render in a clean profile. When you take a screenshot you
are photographing the person's live window — their session, their scroll
position, their half-typed input. That is the point of the tool, and it is also
the thing to be careful about: you are looking at *their* screen.

## The order that works

1. **Set the device, then open the URL.** `custom_ai_view_open` takes both.
   Opening first and switching after reloads the page and throws away whatever
   state it had.
2. **Wait for the page, do not sleep.** `custom_ai_view_wait` takes a selector or
   waits for loading to finish. A fixed delay is either too short on a cold start
   or wasted on a warm one.
3. **Then look.** `custom_ai_view_screenshot` returns the picture itself, not a
   path — read it.

```
custom_ai_view_open       { url, device }      open a URL on a given device
custom_ai_view_wait       { selector | load }  wait for an element, or for loading
custom_ai_view_screenshot { }                  the live window — and it says so when it is not
custom_ai_view_find       { selector | text }  elements, with real visibility
custom_ai_view_click      { selector }         tap something
custom_ai_view_type       { selector, text }   type, optionally submitting on Enter
custom_ai_view_key        { key }              Enter, Escape, Tab, arrows
custom_ai_view_scroll     { dx, dy, selector } the page, or one scroller inside it
custom_ai_view_inspect    { selector }         markup, computed styles, box, ancestry
custom_ai_view_tree       { }                  walk the DOM a level at a time
custom_ai_view_edit       { selector, ... }    change the live page; survives reload
custom_ai_view_revert     { }                  put an edit back, or all of them
custom_ai_view_console    { limit }            page output and the browser's own messages
custom_ai_view_state      { }                  what is open: address, device, viewport, selection
custom_ai_view_devices    { }                  the catalogue, with points, pixels, millimetres
custom_ai_view_set_device { device }           change device without losing the page
custom_ai_view_reload     { mode }             normal, hard, or clearing the cache
custom_ai_view_back       { }                  back without losing SPA state
custom_ai_view_record     { }                  recording with no fixed length
custom_ai_view_collect    { }                  screenshot + markup + console + selection
custom_ai_view_library    { }                  what has been captured, filed by site
```

## The one thing it cannot do

**The renderer is Chromium, whatever the frame says.** An iPhone frame is a real
iPhone's geometry — its millimetres, its bezels, its notch, its safe areas, its
touch behaviour — around a Chromium engine wearing an iOS user-agent. It is not
WebKit.

So layout, spacing, tap targets, safe areas and anything about *size* are true.
A rendering bug specific to Safari — a flexbox quirk, a date input, a
`backdrop-filter` difference, an iOS-only scroll behaviour — will not reproduce
here and cannot be ruled out here. When the question is "why does this look
wrong **on my iPhone**", this narrows it; it does not settle it. Say so rather
than reporting the frame as proof.

Firefox likewise is not available.

## Things that will otherwise cost you a round trip

**Find by selector, not by visible text, unless the text is yours.** A site
picks its language from the browser, so the string you are searching for may not
be the string on the screen. `find` by `h1`, `[data-testid]`, a class — then read
what it says.

**A screenshot tells you whether it is live.** The reply says so explicitly. If
it reports the headless path, the picture is a re-render *without the session* —
a logged-in page will come back as a login form. Do not reason about the user's
data from that picture; say the window was not available and ask them to open it.

**Do not guess a selector for `click` or `inspect`.** `find` returns a selector
that is known to resolve, along with whether the element is really visible —
on screen, not `display:none`, not behind something. Use that.

**`console` carries the browser's own messages too**, not just what the page
printed: a refused frame, a blocked dialog, a failed request, a CSP violation.
When something "just does not work" and the page is silent, look there.

**The device is not a viewport width.** `devices` gives points, pixel ratio,
real pixels and millimetres. When the question is "does this fit", the number
that matters is usually points; when it is "is this tappable", the frame draws a
44 px finger for a reason.

**`edit` survives reload on purpose.** That is what makes it useful for trying a
fix — and what makes it dangerous to leave behind. `revert` when you are done,
and say what you changed.

## Screenshots that are worth taking

- If the device is cropped against the window edge, the zoom is the cause. Ask
  for **Fit** rather than a fixed percentage, or a smaller device.
- A frame photographed mid-animation reads as a bug that is not there. Wait for
  the element you care about, not for the page.
- The device label under the frame prints points, ratio, pixels, millimetres and
  safe-area insets. When reporting a layout problem, quote it — it turns "looks
  cramped" into a measurement.

## When the app is not running

The MCP server starts it. You never need to ask a human to open something first.
If a call still fails, `state` will say what it can see; report that rather than
retrying blindly.

---

© 2026 Custom AI · https://ccustom.ai/view · Proprietary, see LICENSE
