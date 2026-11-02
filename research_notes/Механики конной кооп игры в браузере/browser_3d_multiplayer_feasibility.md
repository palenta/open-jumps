# Technical feasibility (late 2026): 3D 2–4 player horse-jumping game in mobile Safari/Chrome on iPhone & iPad, Blender-made assets

Research date: 2026-11-02. Each source is dated where the page states a date. Anything dated before 2024 is marked **[pre-2024 — may be outdated]** for browser/iOS facts. Note: on iOS *all* browsers (Chrome, Firefox, etc.) use Apple's WebKit engine, so "Safari" limitations below apply to Chrome-on-iOS as well.

---

## KQ1. Which engines/stacks are proven for 3D games in iOS Safari in 2026 (Three.js / Babylon.js / PlayCanvas / Godot 4 web / Unity Web / Bevy-wasm): load size, known issues, what shipped?

### Takeaway
The JS-native engines (Three.js, Babylon.js, PlayCanvas) are what ships at scale on mobile browsers (Shell Shockers = Babylon.js, Bloxd.io = Babylon.js via noa, Venge.io reportedly PlayCanvas); Unity Web officially supports iOS Safari 15+ since April 2025 but its WASM heap is the recurring iOS crash cause, and Godot 4 web exports have a 2025 track record of iOS-only crashes that were only partially fixed in 4.5. For a solo/family project with Blender-authored glTF assets, Three.js (smallest bundle, best glTF/KTX2/meshopt tooling) or Babylon.js (batteries-included) are the low-risk choices.

### Cited Findings
- Bundle sizes (min+gzip, full import), Sep 2026: Three.js ~185 kB (`three`), ~300 kB (`three/webgpu`); Babylon.js ~1.8 MB (all of `@babylonjs/core`); PlayCanvas ~615 kB. Weekly npm downloads Sep 15–21 2026: three 12.18M, @babylonjs/core 315k, playcanvas 57k. — [Utsubo comparison, updated Sep 24 2026](https://www.utsubo.com/blog/threejs-vs-babylonjs-vs-playcanvas-comparison)
- WebGPU maturity per engine (same source): Three.js "production-ready since r171 (Nov 29 2024)", `import { WebGPURenderer } from 'three/webgpu'` with automatic WebGL 2 fallback; Babylon.js WebGPU since 5.0 (May 2022), native WGSL shaders since 8.0 (Mar 2025), current major 9.0 (Mar 2026), `EngineFactory.CreateAsync()` auto-picks WebGPU; PlayCanvas WebGPU backend "labeled beta", auto-fallback to WebGL 2. Three.js has no built-in physics/audio; Babylon and PlayCanvas do. — [Utsubo, Sep 2026](https://www.utsubo.com/blog/threejs-vs-babylonjs-vs-playcanvas-comparison)
- PlayCanvas official guidance: "100–200 draw calls is a rough target for low end mobile devices"; a mesh instance = a draw call; keep shader variant count low (shader compile causes startup delay/frame glitches); skinned meshes cost per-bone every frame even off-screen. — [PlayCanvas optimization guidelines](https://developer.playcanvas.com/user-manual/optimization/guidelines/)
- Shell Shockers (shellshock.io), a multi-million-dollar web FPS, is built on Babylon.js. — [Babylon.js forum, Feb 4 2023 — pre-2024](https://forum.babylonjs.com/t/deep-dive-shell-shockers-multi-million-web-game-success/37927)
- Bloxd.io runs on the `noa` voxel engine, whose README lists bloxd.io among users; noa "uses Babylon.js for 3D rendering". — [noa GitHub](https://github.com/fenomas/noa). Bloxd's own hiring material says the codebase is TypeScript-first using React, WebGL and Node, with 15 million monthly players. — [Bloxd job listing](https://hitmarker.net/jobs/bloxd-software-engineer-gameplay-game-engine-2934442)
- Venge.io: an Indie Hackers commenter says "hordes.io has been made on three.js and venge.io has been made in Playcanvas" (hedged "if I'm not mistaken") and that Venge.io was built by one person. **Unverified.** — [Indie Hackers thread](https://www.indiehackers.com/post/how-to-build-a-game-like-hordes-io-or-venge-io-d0c63d8b34)
- Smash Karts: developed/published by Tall Team (Dublin, started 2020); CrazyGames lists platforms "Web browser (desktop and mobile), iOS, Android" and engine only as "HTML5". — [CrazyGames listing](https://www.crazygames.com/game/smash-karts); [dotgg.gg on Tall Team](https://dotgg.gg/tall-teams-smash-karts-success-continues-with-obby-roads-on-poki/)
- Kour.io: developer Legion Games on CrazyGames; engine not stated. — [CrazyGames Kour.io](https://www.crazygames.com/game/kour-io)
- Godot 4 web export: requires WebAssembly + WebGL 2.0; C# projects cannot be exported to web in Godot 4; multi-threaded builds need `SharedArrayBuffer` → cross-origin isolation headers ("no ads, nor third-party integrations"). — [Godot docs, stable (4.7)](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html). Godot 4.3 removed the SharedArrayBuffer requirement for web builds. — [Godot forum](https://forum.godotengine.org/t/godot-4-3-will-finally-fix-web-builds-no-sharedarraybuffers-required/38885)
- Godot iOS-browser crash reports 2025: issue #107390 "Godot 4.5 dev5 HTML export web game crashes/reloads in iOS Chrome and Safari after a few minutes if audio is used" (reproducible in 4.5.dev5 and 4.4.1, not in 4.3; opened Jun 11 2025, closed Jun 25 2025). — [godotengine/godot#107390](https://github.com/godotengine/godot/issues/107390) via [Godot forum thread, Jun 2025](https://forum.godotengine.org/t/game-crashes-randomly-on-ios-devices-html-export/114043). A 4.3 export worked on iOS 17 but showed WebGL context loss and crashed on iOS 18. — [Godot forum](https://forum.godotengine.org/t/webgl-context-loss-and-app-crash-in-godot-4-3-exported-web-on-ios-browsers/81024). A 4.4.1 export crashed/refreshed on iOS only; a commenter claimed iOS reloads the page when runtime memory exceeds ~300 MB (unverified); several users said 4.5 betas fixed their crashes. — [Godot forum](https://forum.godotengine.org/t/web-export-to-ios-suddenly-crashing-after-working-for-ages/120627)
- Unity Web: official browser matrix lists "iOS Safari 15 and newer" for mobile. — [Unity 6 docs, Web browser compatibility](https://docs.unity3d.com/Manual/webgl-browsercompatibility.html). Unity roadmap item "Web: mobile browser support" marked Released Apr 2 2025. — [Unity roadmap](https://activation.unity3d.com/roadmap/415-web-mobile-browser-support)
- Unity Web memory model: the Unity heap is one contiguous WebAssembly `Memory` block that grows up to 4 GB per "Maximum Memory Size"; "Automatic resizing of the heap can cause your application to crash if the browser fails to allocate a contiguous memory block… keep the Unity heap size as small as possible". — [Unity 6 docs, Memory in Unity Web](https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-memory.html)
- Unity on iOS community reports: random crashes on iOS 18 (works on iOS 17) with a suggestion that iOS 18.4 changed memory management; advice to keep reduced iOS builds under ~500 MiB on 2–3 GiB devices and load an empty scene first. — [Unity Discussions (forum, 2025)](https://discussions.unity.com/t/webgl-random-crashes-on-ios-18-works-fine-on-ios-18/1627624). Secondhand claim of a browser-imposed ~512 MB WebGL memory ceiling on 4 GB iOS devices; Safari force-reloads with no error logged. — [Unity Discussions](https://discussions.unity.com/t/webgl-memory-increment-issue-and-crash-on-ios/894771)
- No head-to-head mobile-Safari FPS benchmark of Three vs Babylon vs PlayCanvas was found; comparison articles are vendor/marketing level. — [Utsubo](https://www.utsubo.com/blog/threejs-vs-babylonjs-vs-playcanvas-comparison); [Cinevva 2026 engine comparison](https://app.cinevva.com/blog/2026-06-09-web-game-engines-2026-comparison)

### Inferences
- For a small team with a scripted Blender→glTF pipeline, Three.js is the natural fit: smallest payload, first-class GLTFLoader/KTX2Loader/meshopt support, and the Colyseus netcode demos are already written in Three.js. Babylon.js is equally shippable (Shell Shockers, Bloxd) and bundles physics/audio/GUI, at ~10× the base download.
- Unity Web and Godot web are viable only if you already have the engine skill; both add a large WASM runtime, a contiguous-heap failure mode on iOS, and (Godot) a 2025 history of iOS-only crashes. They offer no advantage for a glTF-centric asset pipeline.
- Bevy/wasm was not researched (search budget exhausted); treat as unproven for mobile Safari unless validated.

### Gaps
- Could not confirm Smash Karts' engine (no primary source; CrazyGames only says "HTML5"), nor Venge.io's (single unverified forum comment), nor Krunker's or 1v1.lol's. Taming.io not researched.
- No measured iPhone frame-rate comparison between the three JS engines exists in the sources found; must be measured on-device.
- Bevy/wasm on iOS Safari: not researched.

---

## KQ2. WebGPU on iOS Safari: shipped in iOS 26 or still partial? Should a 2026 project target WebGL2 with WebGPU optional?

### Takeaway
WebGPU shipped enabled-by-default in Safari 26.0 (Sep 15 2025) on iOS/iPadOS, and Apple calls it the preferred API — but production engines hit a flicker/crash bug on iOS 26.0–26.2 that forced Construct to disable WebGPU on all Apple platforms until a fix, and a separate WebGPU regression was reported in Safari 26.4. Target WebGL2 as the baseline renderer and expose WebGPU behind a feature flag with a kill switch.

### Cited Findings
- "WebKit for Safari 26.0 adds support for WebGPU… WebGPU supersedes WebGL on macOS, iOS, iPadOS, and visionOS and is preferred for new sites and web apps. It maps better to Metal… WebGPU has been enabled in Safari Technology Preview for over a year, and is now shipping in Safari 26.0 for macOS, iOS, iPadOS, and visionOS." — [WebKit blog, Sep 15 2025](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- caniuse: Safari on iOS — 17.4–18.7 "Disabled by default", 26.0+ "Supported"; global WebGPU support 85.8% + 2.02% partial = 87.82%. — [caniuse WebGPU](https://caniuse.com/webgpu)
- WebKit bug 301627 (reported Oct 29 2025 by Construct's Ashley Gullen): "Safari on iOS 26 adds support for WebGPU… the canvas appears to flicker… This makes WebGPU unusable in Safari." Comment 10 (Jan 8 2026): "This issue still reproduces for me in Safari 26.2… we're going to have to disable WebGPU entirely on iOS and fall back to WebGL rendering"; Comment 11: also reproduces on macOS Safari 26.2. Marked RESOLVED DUPLICATE of bug 302711 "WebGPU Crash on iOS with Time-Varying Mesh Access using instancing vertex buffers" — RESOLVED FIXED. — [WebKit Bugzilla 301627](https://bugs.webkit.org/show_bug.cgi?id=301627); [WebKit Bugzilla 302711](https://bugs.webkit.org/show_bug.cgi?id=302711)
- A commenter in the same thread on WebKit WebGPU timing: expect "pretty much fixed 16ms vsync delay on WebKit" and `GPUQueue.onSubmittedWorkDone()` arriving "in roughly 32ms (2 v-syncs)", later than other browsers. — [WebKit Bugzilla 301627](https://bugs.webkit.org/show_bug.cgi?id=301627)
- A separate report says WebGPU rendering broke in Safari 26.4 but not 26.3, also seen on iOS (filed by the Rerun project). — [WebKit Bugzilla 315186](https://bugs.webkit.org/show_bug.cgi?id=315186)
- Three.js `WebGPURenderer` falls back to WebGL 2 automatically; Babylon `EngineFactory.CreateAsync()` likewise. — [Utsubo, Sep 2026](https://www.utsubo.com/blog/threejs-vs-babylonjs-vs-playcanvas-comparison)

### Inferences
- The Safari WebGPU implementation has shipped but is still receiving correctness fixes in 26.x point releases; a family project cannot wait on Apple release cadence, so WebGL2 must be the guaranteed path.
- For a scene of 4 horses + arena + jumps, WebGL2 is not the bottleneck; WebGPU's benefit (compute, lower CPU overhead) is marginal here. Use `three` (WebGL) build by default; optionally try `three/webgpu` only on Safari ≥ a version you have tested, with a URL/localStorage kill switch.

### Gaps
- Exact Safari version in which bug 302711's fix shipped was not extracted from the bug page (only "RESOLVED FIXED" status confirmed).
- No three.js-specific WebGPURenderer-on-iOS-26 report found.

---

## KQ3. Multiplayer for 2–4 players: Colyseus vs PartyKit/Durable Objects vs Nakama vs Photon vs Playroom vs Hathora vs Rivet vs plain ws vs WebRTC (PeerJS/Geckos) — fit, hobby-scale cost, room codes, host migration, mobile reconnects

### Takeaway
PartyKit's hosted platform shut down on 23 Oct 2026 (successor: PartyServer on your own Cloudflare account, whose free plan includes SQLite-backed Durable Objects and 100k requests/day). For a 2–4 player co-op with server-authoritative or host-validated logic, the two best fits are (1) Colyseus (MIT, self-host on a ~$2–5/month VM or Colyseus Cloud from $15/month; rooms, 9-char room IDs customizable to codes, `allowReconnection()`, built-in prediction/rollback since 0.18) and (2) PartyServer/Durable Objects (effectively free at family scale, WebSocket hibernation, but you write your own room/state code). Playroom Kit is the fastest zero-backend option with room codes, lobby, joystick and gamepad built in, but its pricing page could not be read and its free tier is reportedly non-commercial/low-DAU. WebRTC data channels (Geckos.io) need UDP port ranges on the host and are not justified at this player count.

### Cited Findings
- **PartyKit shutdown**: "The hosted PartyKit platform is shutting down. Deploys stop on 16 October and the platform shuts down on 23 October 2026." Timeline: 9 Oct 2026 no new projects; 16 Oct deploys off; 23 Oct platform shut down and room data deleted; `npx partykit deploy` stops working. "PartyServer is the successor… keeps the same model (rooms, connections, onConnect/onMessage, hibernation, broadcasting) but runs as a plain Cloudflare Worker with Durable Objects in your own Cloudflare account… The Workers free plan includes SQLite-backed Durable Objects." Client `partysocket` keeps working. — [PartyKit migration guide](https://docs.partykit.io/guides/migrate-to-partyserver/); [PartyKit docs banner](https://docs.partykit.io/)
- PartyServer repo: core library "enhances a standard Durable Object to make it easier to work with WebSockets… lifecycle hooks and broadcasting"; PartySocket "features reconnections, buffering, resilience". README says "Much like life, this is a Work in Progress." — [cloudflare/partykit](https://github.com/cloudflare/partykit)
- **Cloudflare Durable Objects pricing** (page updated Oct 18 2026): Free plan 100,000 requests/day and 13,000 GB-s duration/day; Paid plan 1M requests/month included then $0.15/million, 400,000 GB-s/month then $12.50/million GB-s. "Includes HTTP requests, RPC sessions, WebSocket messages, and alarm invocations." Hibernatable idle objects are not billed for duration; "The WebSocket Hibernation API can dramatically reduce duration-related charges". Free plan: "If you exceed any one of the free tier limits, further operations of that type will fail with an error." DOs available on Workers Free (SQLite backend only). — [Cloudflare DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/); [Workers pricing, updated Oct 2 2026](https://developers.cloudflare.com/workers/platform/pricing/)
- Cloudflare WebSocket best practices (updated Oct 30 2026): batch 10–100 logical messages per frame, "Batch every 50–100ms or every 50–100 messages" for game state; hibernation only when the DO is the WebSocket *server*; `setTimeout`/`setInterval`, alarms and pending requests prevent hibernation. — [Cloudflare DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- Workers Free: 100,000 requests/day, 10 ms CPU per invocation; Paid (Standard) $5/month base with 10M requests included; WebSocket upgrade counts as one request and "WebSocket messages routed through a Worker do not count as requests"; static asset requests free and unlimited. — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- **Colyseus 0.18**: rooms & matchmaking ("visibility flags, lobbies, and ranked queues"), server-defined state with binary delta patches, "Built-in client prediction, rollback, interpolation, and lag compensation, new in 0.18", SDKs for Web, Unity, Godot, Defold, GameMaker, Construct, Haxe; "Self-host for free, or use Colyseus Cloud". — [Colyseus docs](https://docs.colyseus.io/)
- Colyseus room IDs: "By default, a random 9-character-long string is assigned as the Room ID. You may customize the Room ID during onCreate() by setting this.roomId" (recipe: Customize Room ID). Reconnection: "`allowReconnection()` lets a dropped client return to the room within a time window, or under manual control"; `client.reconnectionToken` regenerated per connect. `maxClients = 4` example. — [Colyseus Rooms](https://docs.colyseus.io/room)
- Colyseus scalability: each room lives in one process; Redis required for multi-process scaling. — [Colyseus scalability](https://docs.colyseus.io/scalability)
- Colyseus pricing: Open Source free "Self-host on your own servers… No restrictions"; Colyseus Cloud "Starting at $15/mo… No CCU/DAU/MAU limits, Unlimited bandwidth". — [colyseus.io/pricing](https://colyseus.io/pricing)
- Colyseus netcode demos (browser-playable, open source): Air Hockey "where everything is predicted: your mallet, the puck, hits and even goals resolve locally and are settled by the server" (Three.js, Godot, Unity clients); ColyStrike FPS with predicted movement + reconciliation + lag-compensated hitscan; MOBA on deterministic fixed-timestep simulation. — [Colyseus netcode](https://docs.colyseus.io/netcode)
- **Playroom Kit**: room-code flow via `getRoomCode()` and passing `roomCode` to `insertCoin()`; "Playroom Kit does not handle [reading the code from the URL] for you". Feature list includes Lobby, RPCs, Matchmaking, Joystick, "Out-of-box Mobile gaming", Gamepad support, Stream Mode, Discord/TikTok integrations; framework guides for Three.js, PlayCanvas, Unity. — [Playroom lobby docs](https://docs.joinplayroom.com/features/games/lobby); [Playroom docs index](https://docs.joinplayroom.com/)
- Playroom pricing (third-party aggregators only; official page is JS-rendered and returned no text): free plan, no credit card, limited to non-commercial/low DAU (one listing says 10 DAU); paid ~$10/month "Lite"/"Starter". **Unverified.** — [aitoolscoop listing](https://aitoolscoop.com/tool/playroom/); [G2 Playroom](https://www.g2.com/sellers/playroom)
- **Rivet Cloud**: Free "$0/mo for control plane… 1 control plane node in 1 availability zone, Up to 1 Actor Node"; Hobby $10/month (up to 3 Actor Nodes); Team $120/month; e.g. one R-5 Actor Node adds $4.20/month. — [Rivet pricing](https://rivet.dev/pricing)
- **Nakama**: open-source server free to self-host; managed Heroic Cloud is paid (one aggregator lists no permanent free plan). — [toolradar Nakama pricing (aggregator)](https://toolradar.com/tools/nakama/pricing); [Heroic Cloud pricing page (not fetched)](https://heroiclabs.com/pricing)
- **Geckos.io** (WebRTC/UDP client-server): deployment requires forwarding "9208/tcp… and 1025-65535/udp" to the app; signaling on 9208, peer connection on a random UDP port. — [geckos.io README](https://github.com/geckosio/geckos.io)
- **PeerJS/Safari**: a PeerJS fork notes Safari supports only string data on DataConnection so JSON serialization is needed. **[dated fork; verify]** — [@creately/peerjs](https://npmjs.com/package/@creately/peerjs). Old WebKit data-channel ICE issues (iOS 11–12) — [WebKit bug 186302, 2018 — pre-2024](https://bugs.webkit.org/show_bug.cgi?id=186302)
- **WebTransport**: Safari on iOS supported from 26.4. — [caniuse WebTransport](https://caniuse.com/webtransport)
- **iOS background/sleep WebSocket behavior**: "iOS Safari silently closes WebSocket connections when a tab loses focus or the device sleeps, without firing onclose on the client. The connection appears alive to JS but is actually dead." Fix merged: `visibilitychange` + `pageshow` handlers (bfcache restore fires `pageshow` with `persisted: true` and *not* `visibilitychange`), 5 s hidden threshold, resync state after reconnect. Follow-up: second background cycle failed on iOS 18 because pusher-js's transport strategy has a `lives: 2` budget consumed by code-1006 unclean closes. — [flarum#4588](https://github.com/flarum/framework/issues/4588); [flarum PR #4590](https://github.com/flarum/framework/pull/4590); [flarum#4597](https://github.com/flarum/framework/issues/4597). Socket.IO thread suggests Visibility API workaround — [socket.io#2924 — pre-2024](https://www.github.com/socketio/socket.io/issues/2924)
- Photon Fusion web: not found in sources; see Gaps.

### Inferences
- Hobby-scale monthly cost: PartyServer on Cloudflare = $0 (free plan) if requests stay under 100k/day — a 4-player session at 20 msgs/s per client ≈ 80 msgs/s ≈ 288k WebSocket messages/hour, which *exceeds* the free daily request cap after ~8 hours of play unless messages are batched (Cloudflare itself recommends 50–100 ms batching); on Paid ($5/mo) the same traffic is ~1M messages per 3.5 h → ~$0.15 per million beyond included. Colyseus self-hosted on Fly.io's smallest machine ≈ $2–4/month (see KQ7). Colyseus Cloud $15/month. Playroom free tier if non-commercial.
- Host migration is not a built-in feature of any of these for a 4-player game; with a server-authoritative room (Colyseus/DO) there is no host to migrate — the room survives any client dropping, and `allowReconnection()`/DO hibernation handle the iOS background-tab case.
- Room-code joining (Jackbox-style) is native in Playroom and trivially implemented in Colyseus (`this.roomId = code` in `onCreate`) or PartyServer (room name = code).
- WebRTC (Geckos/PeerJS) adds NAT/UDP-port and iOS-quirk risk for no benefit at 2–4 players over a 20–30 Hz WebSocket; WebTransport only became available on iOS in 26.4 and offers no mature game-server ecosystem yet.

### Gaps
- Playroom's official pricing/limits could not be read (JS-only page).
- Hathora's pricing page was fetched but concrete per-hour/vCPU numbers were not extractable; one aggregator says "$2–$5" without basis. Photon Fusion web support/pricing not researched.
- No source on Nakama's current free tier beyond aggregators.
- No source measuring Durable Object WebSocket latency from iOS devices.

---

## KQ4. Latency: for a jump that must be triggered inside a ~150–300 ms window, is client-side prediction needed? How do browser racing games handle it?

### Takeaway
Classic client-side prediction + server reconciliation (Gambetta) exists for *movement*; for a discrete timing event like a jump, the standard approach is to resolve the jump on the local client immediately (the client is the judge of its own horse) and have the server validate using the client's timestamped input, which keeps the 150–300 ms window independent of round-trip latency. No reliable description of Smash Karts' netcode was found.

### Cited Findings
- Client-side prediction: the client applies its own inputs immediately; server reconciliation adds a sequence number to every input, the server replies with the last processed sequence number, and the client re-applies unacknowledged inputs on top of the authoritative state. — [Gabriel Gambetta, Client-Side Prediction and Server Reconciliation (undated classic)](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)
- Colyseus tutorial: update the current player's position immediately at the client's update-loop rate and linearly interpolate other players; includes a section on simulating latency locally. — [Colyseus Phaser tutorial Part 3](https://docs.colyseus.io/learn/tutorial/phaser/client-predicted-input)
- Colyseus 0.18 ships prediction, rollback, interpolation and lag compensation plus open-source Three.js demos where "even goals resolve locally and are settled by the server". — [Colyseus netcode](https://docs.colyseus.io/netcode)
- A 2026 guide advises: "start without prediction and add it only when movement feels laggy", and WebTransport "is not yet safe as the sole transport for beginners, so WebSocket remains the practical choice". — [Cinevva multiplayer guide, 2026](https://app.cinevva.com/hi/guides/multiplayer-browser-game)
- Ludoteca (browser game hub) pairs server-side validation of all client actions with lag compensation. — [Kitemetric engineering write-up](https://kitemetric.com/blogs/scaling-ludoteca-how-we-built-a-browser-based-multiplayer-game-hub)
- WebKit timing: fixed ~16 ms vsync; `onSubmittedWorkDone` ≈ 32 ms. — [WebKit Bugzilla 301627 comment](https://bugs.webkit.org/show_bug.cgi?id=301627)
- Smash Karts: no source describes its networking (results were SEO "fix lag" pages). — [search summary; e.g. gamespew list, Oct 2026](https://www.gamespew.com/2026/10/5-free-multiplayer-browser-games-to-play-with-friends/)

### Inferences
- Design the jump mechanic so the *local* client decides hit/miss from the local horse position and local tap time (deterministic per-horse approach + the player's tap). Send `{tick, horseId, tapTime}` to the server; the server replays the approach from its own authoritative horse state and accepts the result if within tolerance (e.g. ±50 ms). Latency then only affects how soon *other* players see your result (100–300 ms later), not whether you hit the window.
- Full movement prediction/rollback is unnecessary for a co-op jumping course: horses can be interpolated for remote viewers at a 20–30 Hz tick with ~100 ms interpolation delay. If horses can collide, make collisions cosmetic.
- Render at 60 Hz locally regardless of network tick; iOS gives a stable 16.7 ms frame on 60 Hz panels.

### Gaps
- No primary source on Smash Karts', Venge.io's or Kour.io's tick rate/prediction strategy.
- No measured iPhone→DO or iPhone→Colyseus RTT figures found.

---

## KQ5. Blender → web pipeline: rigged quadruped with multiple clips, Rigify/animal rigs, free animal animation sources, mesh/texture budgets, LODs, KTX2/Basis, Draco/meshopt, scripted (bpy/CLI) export

### Takeaway
Blender's built-in glTF exporter (operator `bpy.ops.export_scene.gltf`) is fully scriptable from `blender -b … --python`, can emit one glTF animation per Action or per NLA track, and can apply Draco or meshopt (EXT_meshopt_compression) or hand off to gltfpack for KTX2 textures and mesh simplification; Rigify ships a built-in Horse meta-rig; Mixamo is humanoid-only, and the practical free quadruped sources are Quaternius' CC0 animated animal packs (FBX/OBJ/Blend/glTF). Post-process with `gltf-transform` (meshopt compresses *both* geometry and animation; Draco compresses geometry only).

### Cited Findings
- Blender 4.2 glTF exporter animation modes: **Actions** (default), **Active Actions merged** ("only one animation is exported using the active actions on all objects"), **NLA Tracks** ("each NLA Track will be export as an independent glTF animation… If you rename two tracks on two different objects to the same name, they will become part of the same glTF animation and will play together"). — [Blender 4.2 LTS manual, glTF 2.0](https://docs.blender.org/manual/en/4.2/addons/import_export/scene_gltf2.html)
- `bpy.ops.export_scene.gltf(...)` parameters (current API): `export_animation_mode='ACTIONS'` (default), `export_nla_strips_merged_animation_name='Animation'`, `export_force_sampling=True`, `export_frame_range`, `export_def_bones=False` (export only deform bones), `export_draco_mesh_compression_enable=False` with `export_draco_mesh_compression_level=6`, position/normal/texcoord quantization 14/10/12 bits, `export_meshopt_compression_enable=False` (`EXT_meshopt_compression`), `export_use_gltfpack=False` with `export_gltfpack_tc=True` ("Convert all textures to KTX2 with BasisU supercompression"), `export_gltfpack_tq=8`, `export_gltfpack_si=1.0` ("Simplify meshes targeting triangle count ratio"), `export_image_format='AUTO'` (WebP options), `export_apply=False` (apply modifiers), `export_yup=True`. — [Blender Python API, Export Scene Operators](https://docs.blender.org/api/current/bpy.ops.export_scene.html)
- Rigify: meta-rigs are assemblies of sub-rig "samples"; "new meta-rigs can be built assembling sub-rigs in different ways" (Cat meta-rig shown built by samples). — [Blender 4.2 manual, Rigify meta-rigs](https://docs.blender.org/manual/en/4.2/addons/rigging/rigify/metarigs.html). The Rigify source tree contains `rigify/metarigs/Animals/horse.py` alongside cat and wolf. — [blender-addons v3.6.0 Animals folder](https://projects.blender.org/blender/blender-addons/src/tag/v3.6.0/rigify/metarigs/Animals)
- Rigify→game-engine cleanup: "Sanitize Rigify" (free add-on) exports Rigify rigs as game-engine-ready FBX/glTF. — [itch.io](https://twenty-bear-aces.itch.io/sanitize-rigify). Animal Rigger Pro ($29) auto-rigs standing quadrupeds and exports glTF, but requires Blender 5.1+ and "cloven-hoofed animals are not supported yet". — [Superhive FAQ](https://superhivemarket.com/products/animal-rigger-pro/faq)
- Mixamo: "Currently, the auto-rigger and animation libraries are for bipedal humanoids only." — [Adobe Mixamo FAQ, last updated Sep 14 2021 — pre-2024 but still the current FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)
- Quaternius "Ultimate Animated Animal Pack": 12 models, animated, formats FBX/OBJ/Blend/glTF, license CC0. — [quaternius.com](https://quaternius.com/packs/ultimateanimatedanimals.html). Quaternius "LowPoly Animated Animals" (farm pack): "6 Animated Animals with Death, Idle, Jump, Run and Walk animations in FBX, OBJ and Blend", tagged horses, CC0. — [itch.io](https://quaternius.itch.io/lowpoly-animated-animals); mirror with horse tag and CC0 — [OpenGameArt](https://opengameart.org/content/lowpoly-animated-farm-animal-pack)
- Paid rigged horse base meshes with GLB/glTF included exist on Fab (no animations listed). — [Fab listing](https://fab.com/listings/cfbbffd1-ab85-41f6-ad7a-ffe49f373a89)
- gltf-transform CLI 4.5.0: `npm install --global @gltf-transform/cli`; `gltf-transform optimize in.glb out.glb --compress draco --texture-compress webp` (one-shot), `inspect` reports whether a scene is geometry-heavy/texture-heavy/too many draw calls; commands include `draco` ("Compress geometry with Draco"), `meshopt` ("Compress geometry **and animation** with Meshopt"), `quantize`, `simplify`, `weld`, `reorder`, `dedup`, `merge`, `partition`, plus KTX2 `uastc`/`etc1s`. Uses Sharp for images. — [gltf-transform CLI docs](https://gltf-transform.dev/cli). The npm changelog notes `optimize`'s default compression switched to Meshopt in v4.2; example KTX2 command `gltf-transform uastc in.glb out.glb --slots "{normalTexture,occlusionTexture,metallicRoughnessTexture}" --level 4 --rdo 4 --zstd 18`. — [npm @gltf-transform/cli](https://npmjs.com/package/@gltf-transform/cli)
- three.js `KTX2Loader` transcodes Basis Universal/KTX2 to the GPU formats the device supports (ASTC, ETC2, BPTC, S3TC, PVRTC listed among three.js formats). — [three.js KTX2Loader docs](https://threejs.org/docs/#examples/en/loaders/KTX2Loader)
- iOS KTX2 issues reported: some mip levels show artifacts when transcoded to ASTC on iOS (BC3/RGBA fallback fine). — [Babylon.js forum](https://forum.babylonjs.com/t/ktx2-ios-mipmap-issue/59136). UASTC alpha broken in Safari 15.0–15.3, fixed 15.4+. — [Babylon.js forum — pre-2024](https://forum.babylonjs.com/t/ktx2-uastc-alpha-not-working-on-safari-15/29932). 8K .basis failed to load on mobile while 4K worked. — [three.js forum — pre-2024](https://discourse.threejs.org/t/8k-basis-texture-not-loading-on-mobile-4k-works-fine/26425). MAX_TEXTURE_SIZE reported as 16K on iPhone 11 Pro / iPhone SE. — [three.js forum](https://discourse.threejs.org/t/ktx-astc-etc-support/50815)
- PlayCanvas: skinned meshes recompute bounding boxes per bone each frame even off-screen — minimize bone count. — [PlayCanvas guidelines](https://developer.playcanvas.com/user-manual/optimization/guidelines/)

### Inferences
- Scripted pipeline that fits "AI generates via bpy": `blender -b horse.blend --python export.py` where `export.py` sets one NLA track per clip (walk, trot, canter, jump_takeoff, jump_flight, jump_landing, refusal) and calls `bpy.ops.export_scene.gltf(filepath=..., export_format='GLB', export_animation_mode='NLA_TRACKS', export_def_bones=True, export_apply=True, export_force_sampling=True)`; then `gltf-transform optimize horse.glb horse.min.glb --texture-compress ktx2` (or separate `meshopt` + `uastc`/`etc1s` steps). Keep Draco/meshopt out of Blender and do it in gltf-transform so the Blender file stays uncompressed and inspectable.
- For a Rigify Horse metarig, generate the rig, animate on the control rig, then export with `export_def_bones=True` so only DEF- bones (not MCH/ORG/control bones) reach glTF; "Sanitize Rigify" automates this if manual cleanup is painful.
- Quadruped retargeting from FBX packs is not plug-and-play; expect to either use the Quaternius animated horse as-is (its own rig) or hand-author 6–7 short clips on the Rigify horse. Jump take-off/flight/landing and refusal are unlikely to exist in free packs; plan to author them.
- Bone budget: keep the horse skeleton ≲ 40–60 deform bones (Rigify horse generates many more including controls); fewer bones = cheaper skinning on iOS and smaller animation data.

### Gaps
- No free quadruped mocap (BVH) source for gallop/canter was verified (search budget exhausted).
- No source confirming the exact animation list in Quaternius' Ultimate pack or whether it includes canter/trot or a jump.
- No measured KTX2 transcode time on iPhone found.

---

## KQ6. iOS Safari specifics in 2026: memory crash thresholds, requestFullscreen on iPhone, screen.orientation.lock, Web Audio unlock, Vibration, DeviceOrientation permission, PWA install, gamepad, background throttling

### Takeaway
On iPhone in late 2026: no element fullscreen (video only; caniuse still "partial" through iOS 27.2), no `screen.orientation.lock` (not supported through 27.2), no Vibration API (WebKit opposes it), Gamepad API works (since iOS 10.3), DeviceOrientation needs `requestPermission()` inside a user gesture over HTTPS, AudioContext starts suspended until a touch, backgrounded WebSockets die silently, and the page is killed and reloaded under memory pressure with no error — with a ceiling set by Safari, not by physical RAM (a 2025 WebKit bug is still open). Safari 26 lets *any* site be added to Home Screen as a standalone web app.

### Cited Findings
- **Memory**: WebKit bug 300782 (filed Oct 15 2025, status NEW, Apple engineer replied Mar 11 2026): "Pages with heavy WebGL usage and many textures get terminated by iOS memory pressure and immediately reloaded by Safari, causing an endless reload loop until the message 'A problem repeatedly occurred on…'". Commenter: "iOS Safari limits memory usage, it isn't a physical memory limit. Similar Android devices can load like 4 or 16 times more memory without crashing… The solution is typically to reduce texture sizes, or use less textures… growing garbage can trigger this… apps cannot force Garbage Collection"; devtools are wiped on crash. — [WebKit Bugzilla 300782](https://bugs.webkit.org/show_bug.cgi?id=300782)
- three.js forum thread "Memory limit crash on iOS 26" (Sep 14 2025) reports crashes when switching large models on iOS 26 that did not occur on iOS 18. — [three.js forum](https://discourse.threejs.org/t/memory-limit-crash-on-ios-26/86978)
- Secondhand thresholds: ~512 MB WebGL ceiling on 4 GB iOS devices (Unity forum); ~300 MB reload claim (Godot forum); keep iOS build < ~500 MiB on 2–3 GiB devices (Unity forum). **All unverified forum claims.** — [Unity Discussions](https://discussions.unity.com/t/webgl-memory-increment-issue-and-crash-on-ios/894771); [Godot forum](https://forum.godotengine.org/t/web-export-to-ios-suddenly-crashing-after-working-for-ages/120627); [Unity Discussions](https://discussions.unity.com/t/webgl-random-crashes-on-ios-18-works-fine-on-ios-18/1627624). Older: iPad Air 3 tab terminated at ~1.25 GB during WebGL canvas resize leak (iOS 14.2, fixed 14.3). — [Apple Developer Forums, 2020 — pre-2024](https://developer.apple.com/forums/thread/668999)
- Godot forum comment: iOS sends memory-pressure warnings to native apps but "web stuff doesn't [get it]… silence and then your game disappearing with no warning". — [Godot forum, Jun 2025](https://forum.godotengine.org/t/game-crashes-randomly-on-ios-devices-html-export/114043)
- **Fullscreen**: caniuse Safari on iOS "Partial support" from 12 through 27.2 (desktop Safari full since 16.4). — [caniuse Fullscreen API](https://caniuse.com/fullscreen). Apple forum: Safari 17.2 beta exposed Fullscreen API on iPhone behind a flag; a 2025 comment says `requestFullscreen` is still unsupported on iPhone. — [Apple Developer Forums](https://developer.apple.com/forums/thread/133248?page=2). WebKit bug comment (Mar 2025): iPhone can only do video fullscreen. — [WebKit Bugzilla 206854](https://www2.webkit.org/show_bug.cgi?id=206854). Safari 26.0 release notes list only fullscreen *bug fixes* (event dispatch, exit trigger restricted to text-entry focus). — [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- **Orientation lock**: caniuse `ScreenOrientation.lock` — Safari on iOS "Not supported" through 27.2. — [caniuse](https://caniuse.com/mdn-api_screenorientation_lock). WebKit implemented `lock()` mobile-only tied to HTML fullscreen, flag disabled by default as of mid-2024. — [WebKit Bugzilla 257695](https://bugs.webkit.org/show_bug.cgi?id=257695). Video.js: "iOS doesn't support programmatic orientation lock". — [Video.js docs](https://videojs.org/docs/framework/html/how-to/go-fullscreen-and-lock-orientation)
- **Vibration**: caniuse Safari on iOS "Not supported" 3.2–27.2. — [caniuse Vibration](https://caniuse.com/vibration). WebKit formally opposes the Vibration API (standards-positions #267); a hack using `<input type="checkbox" switch>` produces a haptic tick on iOS Safari but may break. — [WebKit standards-positions #267](https://github.com/WebKit/standards-positions/issues/267); [azukiazusa.dev write-up](https://azukiazusa.dev/en/blog/ios-safari-web-haptics)
- **Gamepad**: Safari on iOS supported 10.3 → 27.2. — [caniuse Gamepad](https://caniuse.com/gamepad)
- **DeviceOrientation/Motion**: `DeviceOrientationEvent.requestPermission()` is "Limited availability" (not Baseline); must be called from a user gesture. — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static). Safari requires HTTPS and a user interaction; the method is only exposed in Mobile Safari, not WKWebView. — [OpenReplay guide](https://blog.openreplay.com/understanding-device-orientation-api/); [Defold forum](https://forum.defold.com/t/how-to-force-safari-browser-to-allow-deviceorientation-permission-solved/75641). WebKit bug: permission denied if requested after a Web Worker `postMessage` round-trip even within the gesture. — [WebKit Bugzilla 269706](https://bugs.webkit.org/show_bug.cgi?id=269706)
- **Web Audio**: AudioContext starts suspended on iOS; unlock on both `touchstart` and `touchend` because a touchstart may begin a scroll. — [HackerNoon — likely pre-2024](https://hackernoon.com/unlocking-web-audio-the-smarter-way-8858218c0e09)
- **PWA**: Safari 26 "Every site can be a web app on iOS and iPadOS" — Add to Home Screen now opens as a web app regardless of manifest `display`, matching macOS behavior; SVG icons and data-URL icons supported. — [WebKit Features in Safari 26.0, Sep 15 2025](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- **Background tab / sleep**: iOS Safari silently kills WebSockets (and EventSource) when backgrounded; use `visibilitychange` + `pageshow(persisted)` + app-level heartbeat and resync. — [flarum#4588](https://github.com/flarum/framework/issues/4588); [flarum PR #4590](https://github.com/flarum/framework/pull/4590)
- **WebGL2 on iOS** older issues: WebGL 2 context random crashes in WKWebView iOS 15 (switching to WebGL1 avoided); ETC1 flag false under WebGL2 on iPhone 13 Pro Max. — [three.js forum — pre-2024](https://discourse.threejs.org/t/ktx-astc-etc-support/50815)

### Inferences
- A mobile-Safari game must be designed as a *portrait-or-landscape-tolerant, non-fullscreen* page: hide the URL bar via Add-to-Home-Screen (standalone) rather than `requestFullscreen`; detect orientation with `matchMedia('(orientation: landscape)')` and show a "rotate your device" overlay instead of locking.
- Budget memory as if the ceiling were ~300–500 MB total JS+GPU on a 3–4 GB iPad/iPhone, because Safari kills the tab with no signal and no devtools trace. Prefer KTX2 (GPU-resident compressed) textures over PNG/JPEG decode (which doubles memory during upload).
- Haptics: none. Use audio+visual feedback for the jump beat; the switch-checkbox hack is optional and fragile.
- Tilt steering is possible (DeviceOrientation) but needs an explicit "Enable motion" button inside a tap handler; not worth it for a family game — touch buttons/joystick are reliable, and physical MFi/Xbox/PlayStation controllers work via Gamepad API.
- Handle the "phone locked mid-match" case explicitly: on `visibilitychange→visible` or `pageshow`, reconnect with the reconnection token and request a full state snapshot.

### Gaps
- No authoritative, device-specific memory ceiling numbers; all figures are forum claims (300 MB / 512 MB / 1.25 GB) and the WebKit bug remains open.
- iOS Low Power Mode throttling of `requestAnimationFrame` (commonly reported as 30 fps) and whether ProMotion 120 Hz is exposed to web content: not confirmed from any fetched source.
- Device RAM for the 2–4-year-old target devices was not extracted from the fetched Wikipedia pages (only chips confirmed: iPad 9th gen = A13, iPad 10th gen = A14, iPhone 13 = A15 — [Wikipedia iPad 9](https://en.wikipedia.org/wiki/IPad_(9th_generation)), [iPad 10](https://en.wikipedia.org/wiki/IPad_(10th_generation)), [iPhone 13](https://en.wikipedia.org/wiki/IPhone_13); the iPhone 13 article cites MacRumors "same amount of RAM as iPhone 12" — [MacRumors, Sep 2021](https://www.macrumors.com/2021/09/15/how-much-ram-in-iphone-13/)).

---

## KQ7. Free/cheap hosting (Cloudflare Pages + Durable Objects, Fly.io, Railway, Render) and monthly cost at family scale

### Takeaway
Static client on Cloudflare (free, unlimited static-asset requests) plus either a PartyServer Durable Object (free tier: 100k requests/day, 13k GB-s/day) or a Colyseus server on Fly.io's smallest always-on machine ($2.19/30 days; 512 MB machine $3.69/month) covers a family-scale game for $0–5/month. Railway's free tier after trial is $1/month-equivalent (1 vCPU/0.5 GB) and Hobby is $5/month with $5 usage included; Colyseus Cloud is $15/month; Rivet is free for one Actor Node.

### Cited Findings
- Cloudflare Workers: Free plan 100,000 requests/day; Paid plan $5/month includes 10M requests; "Requests to static assets are free and unlimited"; WebSocket upgrade = 1 request, routed WebSocket messages don't count (as Worker requests; they *do* count as DO requests). — [Workers pricing, updated Oct 2 2026](https://developers.cloudflare.com/workers/platform/pricing/)
- Cloudflare Durable Objects: Free 100k requests/day + 13,000 GB-s/day; Paid 1M requests + 400k GB-s/month included, then $0.15/M requests and $12.50/M GB-s; DOs available on Free plan (SQLite backend). — [DO pricing, updated Oct 18 2026](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- Fly.io: "no monthly platform fee. The smallest always-on app costs $2.19 per 30 days"; example "One shared-cpu-1x 512MB Machine, running continuously $3.69"; 10 GB volume $1.50; 10 GB egress from North America $0.20; Managed Postgres Basic $38 (not needed here). Billed per second; prices for `iad`/`ewr` regions. — [Fly.io pricing](https://fly.io/docs/about/pricing/)
- Railway: "Start with a 30-day free trial with $5 credits, then $1 per month; Up to 1 vCPU / 0.5 GB RAM per service"; Hobby "Includes $5 of monthly usage credits" (plan $5/month per FAQ), Pro "$20 of monthly usage credits"; free tier limited to 1 project / 3 services / 1 replica after trial. — [Railway pricing](https://railway.com/pricing)
- Render: official pricing page is JS-only (no text fetched). Third-party comparison: Starter ~$7/month, 5 GB bandwidth included then $0.15/GB; a 2026 pricing overhaul is reported. **Unverified.** — [Findstack comparison](https://findstack.com/resources/railway-vs-render-vs-fly-io); [tech-insider 2026](https://tech-insider.org/render-vs-railway-vs-fly-io-2026/)
- A WebSocket game server never idles, so idle-based savings on any PaaS don't apply ("a heartbeat means packets never stop… you pay continuously everywhere"). — [Findstack](https://findstack.com/resources/railway-vs-render-vs-fly-io)
- Colyseus Cloud from $15/month (no CCU/bandwidth limits); self-host free. — [colyseus.io/pricing](https://colyseus.io/pricing)
- Rivet: Free $0 (1 Actor Node), Hobby $10/month. — [Rivet pricing](https://rivet.dev/pricing)
- Cloudflare Containers (if you wanted a Colyseus container on Cloudflare): Workers Paid includes 25 GiB-hours memory, 375 vCPU-minutes/month, then $0.0000025/GiB-s and $0.000020/vCPU-s. — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

### Inferences
- Cheapest robust setup: Cloudflare Pages/Workers Static Assets for the client ($0) + PartyServer DO ($0 on Free as long as you batch messages to stay under 100k DO requests/day; $5/month Paid removes the worry). Colyseus-on-Fly is $2–4/month and gives you Node, Redis-free single-process rooms and the richest netcode toolkit.
- Family scale (say ≤ 10 sessions/week × 30 min × 4 players × 20 Hz unbatched ≈ 1.4M DO messages/week) exceeds the free DO daily cap on play days; batching at 50–100 ms per Cloudflare's own guidance cuts it 2–5× and keeps it free.

### Gaps
- Render's current (2026) official prices not readable.
- Hathora and Photon pricing not extracted.

---

## (a) Recommended stack with rationale

### Takeaway
Three.js (WebGL2 renderer, optional WebGPU flag) + TypeScript + Vite for the client; Colyseus 0.18 (self-hosted on Fly.io, or Colyseus Cloud $15/mo) as the server-authoritative room server with 4-letter room codes and reconnection tokens — with PartyServer/Durable Objects as the equally valid "free, serverless" alternative if you prefer Cloudflare-only ops; Blender headless `bpy` export → `gltf-transform` (meshopt + KTX2) → static hosting on Cloudflare.

### Cited Findings
- Three.js smallest bundle (~185 kB) and WebGPU with auto WebGL2 fallback. — [Utsubo, Sep 2026](https://www.utsubo.com/blog/threejs-vs-babylonjs-vs-playcanvas-comparison)
- WebGL2 required by every WASM engine and supported by all target browsers; WebGPU on iOS only since 26.0 and still buggy in 26.x. — [caniuse WebGPU](https://caniuse.com/webgpu); [WebKit 301627](https://bugs.webkit.org/show_bug.cgi?id=301627)
- Colyseus 0.18: rooms, custom room IDs, `allowReconnection`, prediction/rollback/lag comp, Three.js demos; free self-host, Cloud $15/mo. — [Colyseus docs](https://docs.colyseus.io/); [Rooms](https://docs.colyseus.io/room); [pricing](https://colyseus.io/pricing)
- PartyServer = PartyKit successor on your own Cloudflare account; free plan includes SQLite DOs; `partysocket` client with reconnection/buffering. — [PartyKit migration](https://docs.partykit.io/guides/migrate-to-partyserver/); [cloudflare/partykit](https://github.com/cloudflare/partykit)
- Fly.io smallest always-on machine $2.19/30 days. — [Fly.io pricing](https://fly.io/docs/about/pricing/)
- Blender glTF operator supports NLA-track-per-clip export, deform-bones-only, meshopt/Draco, gltfpack KTX2. — [bpy.ops.export_scene](https://docs.blender.org/api/current/bpy.ops.export_scene.html)
- gltf-transform: `optimize`, `meshopt` (geometry + animation), `uastc`/`etc1s` KTX2, `simplify`, `inspect`. — [gltf-transform CLI](https://gltf-transform.dev/cli)
- Playroom Kit as the zero-backend alternative with built-in room codes/lobby/joystick/gamepad (pricing unverified). — [Playroom lobby](https://docs.joinplayroom.com/features/games/lobby)

### Inferences
- Engine: **Three.js** (r17x+, WebGL2 `WebGLRenderer`; try `three/webgpu` only behind a flag). Rationale: tiny payload for cellular loading, best glTF/KTX2/meshopt loaders, the netcode reference demos are Three.js, and it is the easiest for an AI assistant to generate code against (largest corpus). Choose Babylon.js instead only if you want built-in physics/GUI/audio and accept ~1.8 MB.
- Networking: **Colyseus** server-authoritative room (`maxClients = 4`, `roomId` = 4-letter code, `allowReconnection(client, 60)`), 20 Hz state patches, client sends timestamped `jumpTap` inputs; horses rendered with ~100 ms interpolation. Alternative with identical game-design: **PartyServer** DO room with hand-written state diff and 50–100 ms batched broadcasts.
- Hosting: client on Cloudflare Pages / Workers static assets; Colyseus on one Fly.io `shared-cpu-1x` 512 MB machine (~$3.69/mo) in the region nearest the family; or $0 with PartyServer on Cloudflare Free.
- Build tooling: Vite + TypeScript; assets via `blender -b --python export.py` → `gltf-transform` in a `make assets` script; Playwright/WebKit for smoke tests; real-device testing via Safari Web Inspector.

### Gaps
- No benchmark confirming Three.js vs Babylon frame time on A13–A15 devices for a 4-skinned-horse scene; must be measured.

---

## (b) Performance budget table (per frame / per build), target 60 fps on 2–4-year-old iPhone/iPad (A13–A15, 3–4 GB RAM)

### Takeaway
Treat draw calls and total memory — not triangles — as the binding constraints on iOS: ≤ 100–150 draw calls, ≤ 150–300k visible triangles, ≤ 4 skinned characters with ≲ 60 bones each, textures ≤ 2048² as KTX2, total resident JS+GPU memory ≲ 300 MB, and ≤ 10 MB initial download; all numbers come from engine guidelines and practitioner write-ups, not from iPhone benchmarks, so validate on-device.

### Cited Findings
- Draw calls: "100–200 draw calls is a rough target for low end mobile devices" — [PlayCanvas guidelines](https://developer.playcanvas.com/user-manual/optimization/guidelines/); "aim for under 100 draw calls per frame for smooth 60 fps on most mobile devices; above 500… degrades sharply" and "most slow Three.js scenes aren't triangle-bound — they're draw-call-bound, memory-bound" with a rough budget "under ~100–150 draw calls" — [hontran.dev Three.js performance](https://www.hontran.dev/blog/three-js-performance-optimization); stricter "<50 excellent, >200 likely problems" — [MetaDesign Solutions](https://metadesignsolutions.com/blog/threejs-performance-optimization-best-practices)
- Triangles: "fewer than 500,000 visible triangles, with a total download under 10 MB before the first interaction" — [HackerNoon, WebGL interaction budget](https://hackernoon.com/the-interaction-budget-keeping-webgl-interfaces-usable-on-real-devices); game-like interiors "under 150k" triangles — [wikidocs (Korean) renderer numbers](https://wikidocs.net/425950); anecdote: a Verge3D scene with 309 draw calls / ~700k triangles ran slowly even on iPhone 16 (author suspected battery throttling) — [Soft8Soft forum](https://www.soft8soft.com/?p=84978)
- Skinning: per-bone cost every frame even when off-screen; keep shader variants low. — [PlayCanvas guidelines](https://developer.playcanvas.com/user-manual/optimization/guidelines/)
- Batching tools: `BatchedMesh` (three r159+, improved r170) and instancing; measure with `renderer.info` and Spector.js. — [hontran.dev](https://www.hontran.dev/blog/three-js-performance-optimization)
- Memory: Safari-imposed ceiling, not physical; reduce texture count/size; GC pressure counts. — [WebKit 300782](https://bugs.webkit.org/show_bug.cgi?id=300782). Forum ceilings 300–512 MB (unverified). — [Unity Discussions](https://discussions.unity.com/t/webgl-memory-increment-issue-and-crash-on-ios/894771); [Godot forum](https://forum.godotengine.org/t/web-export-to-ios-suddenly-crashing-after-working-for-ages/120627)
- Textures: 8K Basis failed on mobile, 4K ok — [three.js forum — pre-2024](https://discourse.threejs.org/t/8k-basis-texture-not-loading-on-mobile-4k-works-fine/26425); MAX_TEXTURE_SIZE 16384 reported on iPhone 11 Pro — [three.js forum](https://discourse.threejs.org/t/ktx-astc-etc-support/50815)
- Frame pacing on WebKit: fixed ~16 ms vsync. — [WebKit 301627](https://bugs.webkit.org/show_bug.cgi?id=301627)
- Cloudflare: batch network messages every 50–100 ms. — [Cloudflare DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

### Inferences (the budget table)

| Metric | Target (iPhone 13 / iPad 9–10 class) | Hard ceiling | Source basis |
|---|---|---|---|
| Frame rate | 60 fps (16.7 ms), accept 30 fps fallback tier | — | WebKit vsync 16 ms [301627] |
| Draw calls / frame | ≤ 100 | 150–200 | PlayCanvas 100–200 low-end; hontran ≤100–150 |
| Visible triangles / frame | 150k–300k | 500k | wikidocs 150k; HackerNoon 500k |
| Horse mesh | 8–15k tris each, 4 horses ≈ 60k | — | derived from above |
| Skinned characters | 4 horses (+ 4 riders merged into horse skeleton) | — | PlayCanvas per-bone cost |
| Bones per character | ≤ 60 deform bones | ~80 | inference (Rigify DEF subset) |
| Animation clips | 7 clips × ~1–2 s, meshopt-compressed | — | gltf-transform meshopt covers animation |
| Textures | ≤ 2048² per horse atlas, 1024² props, KTX2 (UASTC for albedo, ETC1S for masks) | 4096² | 8K fails on mobile, 4K ok |
| Resident memory (JS + GPU) | ≤ 250–300 MB | ~500 MB | forum ceilings 300–512 MB; WebKit kill with no signal |
| Initial download (gz) | ≤ 5–10 MB | 10 MB | HackerNoon ≤10 MB before first interaction |
| JS bundle (gz) | ≤ 500 kB (three ~185 kB + game) | 1 MB | Utsubo bundle sizes |
| Shader variants | ≤ 10 materials/shader permutations | — | PlayCanvas shader-compile guidance |
| Pixel ratio | cap `devicePixelRatio` at 1.5–2 on phones; 1.5 on iPad | — | common practice; inference |
| Shadows | 1 directional shadow map ≤ 1024², or baked | — | inference |
| Post-processing | none or one cheap pass | — | inference |
| Network tick | server 20 Hz, client input 30–60 Hz, batched 50–100 ms on DO | — | Cloudflare batching guidance |

### Gaps
- No iPhone-measured numbers for any of these; the table is derived from guidelines and must be validated on the actual family devices.

---

## (c) iOS Safari gotchas with workarounds

### Takeaway
Fourteen concrete behaviors, each with a workaround, all sourced in KQ2/KQ6.

### Cited Findings
1. **No element fullscreen on iPhone** (caniuse partial through 27.2; iPad OK). Workaround: ship as Add-to-Home-Screen web app (Safari 26 makes every site installable) and use `100dvh` layouts. — [caniuse Fullscreen](https://caniuse.com/fullscreen); [WebKit Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
2. **No `screen.orientation.lock`**. Workaround: CSS/JS "rotate device" overlay via `matchMedia('(orientation: portrait)')`; design for both. — [caniuse lock](https://caniuse.com/mdn-api_screenorientation_lock); [WebKit 257695](https://bugs.webkit.org/show_bug.cgi?id=257695)
3. **No Vibration API** (WebKit opposed). Workaround: audio/visual feedback; optional `<input type=checkbox switch>` haptic hack. — [caniuse Vibration](https://caniuse.com/vibration); [standards-positions #267](https://github.com/WebKit/standards-positions/issues/267)
4. **AudioContext suspended until gesture**. Workaround: `ctx.resume()` on first `touchend` (and `touchstart`), show a "Tap to start" screen that also unlocks audio. — [HackerNoon](https://hackernoon.com/unlocking-web-audio-the-smarter-way-8858218c0e09)
5. **DeviceOrientation needs `requestPermission()`** inside a direct tap handler over HTTPS; fails after a worker round-trip. Workaround: explicit "Enable tilt" button; prefer touch controls. — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/DeviceOrientationEvent/requestPermission_static); [WebKit 269706](https://bugs.webkit.org/show_bug.cgi?id=269706)
6. **Memory-pressure kill with reload loop, no error, devtools wiped**. Workaround: KTX2 textures, ≤2048² atlases, dispose geometries/textures, avoid GC churn (pool vectors), load progressively; keep total ≲ 300 MB. — [WebKit 300782](https://bugs.webkit.org/show_bug.cgi?id=300782)
7. **WebGPU flicker/crash on iOS 26.0–26.2 (instanced vertex buffers), regression in 26.4**. Workaround: WebGL2 default, WebGPU opt-in with remote kill switch. — [WebKit 301627](https://bugs.webkit.org/show_bug.cgi?id=301627); [WebKit 315186](https://bugs.webkit.org/show_bug.cgi?id=315186)
8. **Backgrounded/locked tab silently kills WebSocket; bfcache restore fires `pageshow(persisted)` not `visibilitychange`**. Workaround: listen to both, treat socket as dead after >5 s hidden, heartbeat, reconnect with token, resync snapshot; test the *second* background cycle. — [flarum#4588](https://github.com/flarum/framework/issues/4588); [flarum#4597](https://github.com/flarum/framework/issues/4597)
9. **Gamepad API works (iOS 10.3+)** — keep polling in rAF; controllers appear only after a button press. — [caniuse Gamepad](https://caniuse.com/gamepad)
10. **Fixed 16 ms vsync; `onSubmittedWorkDone` ≈ 32 ms** — don't gate rendering on GPU completion callbacks. — [WebKit 301627](https://bugs.webkit.org/show_bug.cgi?id=301627)
11. **KTX2→ASTC mip artifacts reported on iOS** — test transcoded textures on device; fall back to RGBA if needed. — [Babylon forum](https://forum.babylonjs.com/t/ktx2-ios-mipmap-issue/59136)
12. **Max texture 16K reported but 8K Basis failed on mobile** — stay ≤ 4K, prefer 2K. — [three.js forum](https://discourse.threejs.org/t/ktx-astc-etc-support/50815); [three.js forum](https://discourse.threejs.org/t/8k-basis-texture-not-loading-on-mobile-4k-works-fine/26425)
13. **Every Home-Screen add opens standalone in Safari 26** — provide a manifest with icons (SVG allowed) and handle `display-mode: standalone` media query for layout. — [WebKit Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
14. **WASM engines (Unity/Godot) need a contiguous heap and crash on iOS when it can't grow** — not applicable if you use a JS engine. — [Unity memory docs](https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-memory.html)

### Inferences
- Additional, commonly reported but **unsourced here**: Low Power Mode may halve rAF to 30 fps; 120 Hz ProMotion is not exposed to web rAF; Safari's bottom toolbar steals ~80 px until scrolled — design HUD with safe-area insets (`env(safe-area-inset-*)`).

### Gaps
- Low Power Mode / ProMotion behavior unverified (search budget exhausted).

---

## (d) Risks to validate first (riskiest assumptions, cheapest tests)

### Takeaway
Before building the game, run four on-device probes in this order: (1) a 4-skinned-horse Three.js scene at the budget above on the family's oldest iPad/iPhone (fps + memory survival for 10 minutes), (2) a WebSocket round-trip + lock/unlock reconnect test from iPhone to the chosen server (Colyseus on Fly vs PartyServer DO), (3) the Blender→glTF→gltf-transform script producing a horse with 7 clips that plays correctly in three.js, and (4) a tap-timing probe showing a 150–300 ms window feels fair with local judgement.

### Cited Findings
- Memory kills are silent and reload-looping; the limit is Safari-set and still an open bug (Mar 2026). — [WebKit 300782](https://bugs.webkit.org/show_bug.cgi?id=300782)
- WebGPU correctness on iOS has regressed within 26.x point releases. — [WebKit 301627](https://bugs.webkit.org/show_bug.cgi?id=301627); [WebKit 315186](https://bugs.webkit.org/show_bug.cgi?id=315186)
- iOS silently drops WebSockets on background; second-cycle reconnect failures were library-specific. — [flarum#4597](https://github.com/flarum/framework/issues/4597)
- Free Durable Object tier fails hard (operations error) when 100k requests/day is exceeded. — [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- Mixamo cannot supply quadruped animation; free packs ship FBX/Blend with limited clips (Idle/Walk/Run/Jump/Death). — [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html); [Quaternius itch](https://quaternius.itch.io/lowpoly-animated-animals)
- Godot/Unity web builds have 2025 iOS crash histories tied to WASM heap/audio. — [godot#107390](https://github.com/godotengine/godot/issues/107390); [Unity Discussions](https://discussions.unity.com/t/webgl-random-crashes-on-ios-18-works-fine-on-ios-18/1627624)
- PartyKit hosted platform is gone (Oct 23 2026); any tutorial/boilerplate targeting `partykit deploy` is obsolete. — [PartyKit migration](https://docs.partykit.io/guides/migrate-to-partyserver/)

### Inferences (ranked by probability-wrong × cost-if-wrong ÷ cost-to-test)
1. **"The target iPad/iPhone sustains 60 fps and survives 10+ min without a memory kill with 4 skinned horses + arena."** Highest risk; cheapest test: a 1-day Three.js probe with placeholder horses (Quaternius CC0) at the budget table numbers, run on the oldest family device, watching for the reload loop.
2. **"WebSocket RTT from the family's phones to the server region is ≤ 100 ms and reconnect-after-lock works twice in a row."** Test with a 50-line Colyseus or PartyServer echo room; lock the phone, wait 30 s, unlock, repeat.
3. **"The scripted Blender pipeline (bpy headless → gltf-transform) yields a rigged horse whose 7 NLA clips play correctly in three.js with deform-bones-only export."** Test with the Rigify Horse metarig on a box-horse mesh before authoring real art.
4. **"A 150–300 ms jump window judged locally feels fair to all 4 players when remote horses are shown ~100 ms late."** Test with a 2-device prototype; measure perceived fairness, not RTT.
5. **"WebGPU is not needed."** Assume true; defer entirely (drop the assumption from the stack).
6. **"Free DO tier suffices."** Low cost if wrong ($5/month); test by counting requests in a real 30-minute session.

### Gaps
- No prior art found for a horse-jumping browser game specifically; comparable timing-based browser multiplayer references were not located.
