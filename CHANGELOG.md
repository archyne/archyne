# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

Archyne is pre-1.0, so the public surface can still change between minor
versions. The version number reaching `1.0.0-alpha.N` does not end that:
semver orders a prerelease _before_ the release it prefixes, so
`1.0.0-alpha.1` is still pre-1.0 and the alpha line continues. Once 1.0
itself ships, the following count as the public API for semver purposes:

- the **`.mmd` file format contract** — in particular the `%% graph:positions`
  and `%% graph:waypoints` comments, which must always leave the file valid
  Mermaid
- the **embed `postMessage` protocol** (`src/embed.ts`)
- the **MCP tool names and their schemas** (`mcp/server.ts`)
- the **`archyne-render` entry points** and the options they take, whose version
  is the same as this one

Breaking any of those requires a major version. The React component structure,
CSS class names and internal store shape are _not_ public API.

## [Unreleased]

### Fixed

- **Connections go round the nodes in their way.** A connection whose two
  ends faced each other — the commonest kind — went straight through any
  node between them: the search for a way round started on the node's own
  face, inside its own margin, and gave up at once.
- **Connections leave and arrive square.** Moving apart two connections that
  shared a corridor could slide the run attached to a node, so a line set
  off along the node's border, or ran along it into the arrowhead with a
  small curl at the end.
- **Two or more connections between the same two nodes start from the right
  side.** They were hung from a node's first handle — its left side — so
  `a --> b` written twice set off from behind `a` and crossed it. They are now
  drawn like every other connection, side by side, as SVG export already drew
  them.
- **A connection between two nearly level nodes is straight**, instead of a
  Z with a step a few units high.
- **Connections reach the outline of a diamond, circle or other shaped
  node**, not the box around it. Off a diamond's point, where several
  connections sharing a side are placed, a line stopped short in the air.
- **Copy from the canvas, paste anywhere.** Ctrl+C (or Copy in the menu)
  puts the selection on the system clipboard as a picture and as its
  Mermaid at once: PowerPoint and Word paste the picture, a text editor
  pastes the code. The picture has no background, so it sits on the slide
  or page as drawn shapes do, and is drawn in the light theme's colours
  so its words read on a white page whatever theme the app is in. With nothing selected the whole diagram goes. The right-click menu adds
  "Copy as image" and "Copy as text", for when the form an application
  prefers is not the one wanted. Before, a
  copy never left the app.
- **Resizing a picture resizes the picture.** Dragging the handles of a
  picture with no frame round it made the box bigger and left the picture
  small in the middle of it, and the Mermaid kept the old size. Now the
  picture grows and shrinks with the handles, in proportion, and the box
  hugs it when let go; the size fields do the same.
- **Crop a picture.** "Crop image…" in a picture's right-click menu opens
  it with a frame to drag, or numbers to type. The crop is cut into the
  picture itself, so the Live Editor and every export show it cropped too;
  the part kept stays the size it was on the canvas, and undo brings the
  rest back.
- **Pictures in the SVG export and in a copy.** A node's picture — every
  icon of an imported Azure or AWS diagram — was missing from the SVG
  export and from a copy pasted into a slide, which kept only the captions.
  Pictures linked from the web are fetched and carried inside the copy.
  Captions with no box round them keep the slim padding they have on the
  canvas, rather than breaking onto an extra line over the icon above.
- **Paste a picture onto the canvas.** An image copied from a web page or
  any other application, pasted onto a flowchart, becomes an image node in
  the middle of the view — scaled down if it is large, since it travels
  inside the Mermaid. Pasting the app's own copy still brings back the
  nodes, not a picture of them.
- **Any page of a draw.io or Visio file can be imported — or several.** The
  import dialog lists the pages and previews the one picked; only the first
  was reachable before, and a file of an overview and its details lost the
  details. Ticking more than one, or "All pages", imports each into a tab of
  its own, named after its page. A file of dozens of pages keeps the list
  in a box that scrolls, so the dialog still fits the window.
- **draw.io pictures come across as pictures.** Icons pasted into a drawing —
  most Azure, AWS and GCP diagrams — and ones from draw.io's own library are
  drawn with their caption above or below and no box round them, instead of
  an empty square with the caption cut short inside it. A drawing made mostly
  of such pictures opens as a flowchart rather than as `architecture-beta`.
- **draw.io groups are dissolved.** A group made with Ctrl+G became a
  subgraph titled with its id — `g1`, `g10` — round the panel that really
  was the box; its shapes now stand where they were, and the panel becomes
  the group. Panels nested inside containers are found as well, and a
  container with no title has none.
- **draw.io connections keep where they meet their boxes.** An end pinned to
  a point of a box, or resting on one, becomes a corner just outside that
  point, so the line leaves and arrives where the author put it instead of
  by whichever face lay nearest the far end — two lines leaving one box no
  longer lie along each other for it. An arrow with its only head at the
  start is turned round, where its head was dropped.
- **Imported pictures stay where they were drawn**: a caption wider than its
  icon no longer pushes the icon off to one side.
- **Groups take the colours a diagram gives them.** `style vnet fill:…` on a
  flowchart subgraph was read and thrown away; it is now kept, written back,
  and drawn on the canvas and in SVG export — with a solid frame, as mermaid
  draws a styled subgraph, unless it has a `stroke-dasharray`. draw.io panels
  arrive with their own fill, frame and dash, white where draw.io leaves the
  fill to its default, and words lying on a panel are written in a colour
  that reads on it rather than in the theme's.
- **A flowchart group's colours can be set in the inspector** — fill, border
  and title — as a node's can.
- **Ready-made colours in the inspector.** A row of fill-and-border pairs —
  draw.io's palette, and a dark one — sets a node's or a group's colours in a
  click, with a text colour that reads on the fill; the pickers offer the
  same colours among their suggestions.
- **Undo takes back a colour picked by dragging in one step.** The picker
  sends a change for every colour the pointer crosses, and each was a step
  of its own, so undo walked back through all of them.
- **Exporting mermaid's own drawing works when a label has two lines.**
  Mermaid hands its drawing back with a bare `<br>` in such a label, which no
  XML reader accepts: PNG and PDF export failed with "could not rasterize the
  mermaid SVG", and the .svg it saved opened nowhere. It is now written out
  as well-formed XML.
- **Large diagrams are drawn in the preview and in export.** Mermaid stops at
  50,000 characters and draws "Maximum text size in diagram exceeded"
  instead; a draw.io import whose icons travel in the file passes that with a
  dozen of them. The limit is now 5,000,000.
- **A group on the canvas has one frame, on its edge.** React Flow's own
  styling drew a second, solid frame round it and set the dashed one 11px
  inside, where neither the SVG export nor draw.io draws it.
- **Imported words stay inside what holds them.** The canvas's text runs a
  little wider than draw.io's, so a label that fitted there could run over
  its box's border here, or across the frame of the zone it sat in. Such a
  label is now set a little smaller — down to the size at which it fits — and
  a zone's title drawn across the frame is moved in off it, unless that
  would put it on a shape beside it. A name breaks at its hyphens, as the
  browser breaks it, and words drawn beside a shape are left as they are.
- **More of a draw.io drawing arrives.** A shape in the corner of its group,
  which draw.io writes with no coordinates, is no longer dropped, and an arrow
  whose end rests on a shape without being glued to it is tied to that shape.
- **Words with no box keep their whole text** on the canvas rather than being
  cut to the box they came in.
- **draw.io and Visio files with an unlabelled shape open.** A box with no
  text — an icon, a dot, a separator — was written as `n1[""]`, which Mermaid
  refuses, so one of them stopped the whole import from opening. The same
  went for a flowchart node or group whose text was deleted in the editor.
- **draw.io colours Mermaid cannot read are left to the theme**: `default`,
  and the `light-dark(…)` pair draw.io writes since its dark mode, whose light
  half is kept.
- **An architecture import with a node named "Title…" opens**: the grammar
  reads `title` at the start of any id as the diagram's title.
- **A draw.io zone drawn round other shapes is imported as a group.** A
  trust boundary, a VPC or a coloured panel laid over the shapes it encloses
  became a giant node with its title in the middle, and an obstacle every
  connection inside it was walled in by. An unfilled box round any shapes, or
  a filled one round two or more, is now a subgraph holding them.
- **Connections drawn inside a draw.io swimlane keep their corners where they
  were**, instead of short of the lane by its offset.
- **A connection's label breaks at `<br>` on the canvas and in exported SVG**,
  instead of showing the tag; a `<br>` draw.io wrote with a style on it no
  longer joins the lines it separated.
- **Small imported tags show their text**: a 40×20 box read "A" for "AV11".
- **A connection with corners leaves and arrives by the faces that look at
  its first and last corner**, and meets the face level with that corner, as
  Visio and draw.io glue one. Chosen against the far node instead, imported
  connections tied knots beside their ends.
- **Busy diagrams route round their nodes.** The search for a way round was
  switched off for any diagram of more than sixty nodes; it now looks only at
  the boxes near each connection. A panel behind other nodes, and text with
  no box, are no longer obstacles.
- **No connection is drawn on the slant**: separating two runs that shared a
  line could pull a neighbouring run off square.
- **Renaming a node in place shows the words as they will be.** The field
  came up in the browser's own type size rather than the label's, so the text
  grew when double-clicked; and it was painted with the canvas's background,
  so a pale node's dark text — common in imported drawings — turned black on
  black in the dark theme. It now sits inside the label and takes the node's
  fill.
- **The import preview and `archyne-render` draw connections as the canvas
  does.** Both rebuilt the diagram from its text without the corners, the
  connection styles and the node looks the document keeps in its comments,
  so an imported drawing's connections were routed from scratch there and
  looked nothing like the canvas it was about to open on.
- **Lines leaving one face set off from different points**, instead of from
  one spot and on top of each other for their first stretch — including two
  boxes stacked edge to edge, whose imported corner sat on the line between
  them.
- **Lines on one face are ordered so that turning off does not cross**: of
  two lines leaving a side and both dropping down, the one that drops first
  takes the lower place, as on a metro map, instead of the order their far
  ends happened to give. Once routed, lines that turned through one shared
  column are put in order again — places, columns or both swapped wherever
  that crosses fewer lines and hides none.
- **Arrowheads on one face no longer touch.** Heads are kept apart along the
  face whatever moved them there, and on a round node only the middle of
  each face takes connections, so heads from two faces do not meet on the
  curve.
- **Connections sharing a corridor are fanned out in the order that crosses
  least**, onto lanes nobody else holds, never across a node, and never in
  towards the node a run leaves — that last check was the wrong way round, so
  a separated run could end up a couple of units off its node with no
  straight line behind the arrowhead.
- **No long detour round both boxes** when two nodes sit close side by side
  but far apart down the page: the faces with room between them are used.

## [1.1.1-alpha.1] — 2026-10-24

### Fixed

- **A connection drawn both ways keeps both arrowheads in exported SVG.** A
  two-way flowchart arrow (`a <--> b`) and a C4 `BiRel` lost the head at their
  start in SVG export and in `archyne-render`; the canvas was never affected.
  Thanks to [@jspizziri](https://github.com/jspizziri).
- **A connection drawn without an arrowhead is exported without one.** A
  flowchart's open link (`a --- b`) and an architecture edge without `<` or
  `>` came out of SVG export and `archyne-render` with an arrowhead the
  canvas does not draw.

### Security

- Electron 44.9.1, and current versions of undici, body-parser and fast-uri.

## [1.1.0-alpha.1] — 2026-10-24

### Added

- **Generate: edit the diagram on screen by asking.** In the overflow menu,
  **More → Generate** takes a request in your own words — "put a cache in
  front of the database", "retry the payment twice" — and turns it into an
  edit of the diagram you are looking at. The answer is ordinary Mermaid: it
  lands on the canvas and in the code, and each one can be undone on its own.
  Archyne ships and hosts no model; Generate uses one you choose. The guide is
  [`docs/generate.md`](docs/generate.md).
- **A model on your own computer, everywhere.** Any server that speaks the
  OpenAI chat API — Ollama and LM Studio have presets — works in the web
  app, the desktop app and VS Code. The web app reaches this computer only:
  its content security policy allows nothing else, so a diagram cannot be
  sent to another machine from it by mistake.
- **A hosted service, from the desktop app and VS Code**: anything
  OpenAI-compatible, Anthropic, Azure OpenAI and AI Foundry, Amazon Bedrock,
  Google Vertex AI and Alibaba Cloud Model Studio. Signing in can be a key in
  any header, HTTP Basic, OAuth (in the browser with PKCE, with a device code,
  as a machine with a secret, a private key or a certificate, or as a service
  account — a Google key file is taken as it is), AWS Signature V4, or a
  client certificate; certificates and keys are loaded from a file, `.pfx`
  included. Checked by hand against Azure: a key, a Microsoft Entra sign-in,
  and in seven languages gpt-5-mini drew 104 of 105 held-out requests right.
- **Keys kept in a cloud vault instead of on this computer.** A service's
  secrets can be read, through the vendor's own command-line tool, from Azure
  Key Vault, AWS Secrets Manager, Google Secret Manager, Alibaba Cloud KMS or
  HashiCorp Vault / OpenBao. Nothing is read until you authorize it, once, in
  a window of the app's own that names the secret, the vault and where it
  goes; the value is held in memory only.
- **Each answer says what it changed.** Nodes and connections added, renamed
  or removed are listed under the answer and marked on the canvas until the
  next thing you do there, and an empty conversation suggests requests built
  from the diagram's own names. All of it in the seven languages of the
  interface.

### Changed

- **Mermaid 12.** The Preview tab draws with Mermaid's own new defaults —
  white fills, black strokes, orthogonal connections — which is what Preview
  is for. Mermaid 12 needs Node 22.12 or later, and so does Archyne.
- Generate loads when it is first opened, so the editor's first load did not
  grow with it.

### Fixed

- **In VS Code 1.143, a `.mmd` file opened from outside VS Code could come
  up as text** despite being associated with Archyne: VS Code sometimes
  opens it before it starts the extension. The extension now starts on the
  file and moves it onto the canvas.

### Security

- **The page never holds a credential.** Every key, password, token and
  certificate stays with the desktop app's main process or VS Code's
  extension host, in the operating system's keychain or VS Code's secret
  storage, and is never sent back to the page. A secret is bound to the
  address it was saved for: a service pointed elsewhere arrives there with
  none. `SECURITY.md` sets out what is in scope.
- DOMPurify 3.4.17, which closes a critical and a high advisory in the
  sanitizer Mermaid's output passes through, and current versions of the MCP
  SDK, Zod, Hono, ip-address and, in the extension, follow-redirects and
  markdown-it.

## [1.0.0-alpha.1] — 2026-08-30

### Changed

- **Archyne moved to its own name.** The repository is now
  [`archyne/archyne`](https://github.com/archyne/archyne) and the demo is at
  <https://archyne.github.io/archyne/>. Nothing about the software changed;
  what changed is where it lives. The move was made deliberately early, while it costs almost nothing:
  a project with real users cannot relocate its identity without spending
  theirs.
- **The extension stays `naxeris.archyne`, and that is the right answer.**
  Moving it to a publisher of the project's own name is not possible: a
  Marketplace extension _name_ is unique across the whole registry, not per
  publisher, so `archyne` is already reserved — by this extension. The
  Marketplace offers no transfer between publishers either. The constraint
  turns out to remove the reason for the move: the risk it was meant to close
  was somebody else registering the publisher `archyne` and publishing
  something that looked more official, and nobody can, because that publisher
  is now held and the name is spoken for. What is left is a publisher ID that
  reads oddly on the listing, and a display name fixes that without touching
  the identifier anyone has installed.
- **`https://dariodd.github.io/archyne/` is gone rather than redirected.**
  Git and web URLs follow a transferred repository permanently, but GitHub
  Pages does not, so that address is a plain 404 and this is the one link the
  move genuinely breaks. The demo is at <https://archyne.github.io/archyne/>
  and every reference in the project points there. It remains a platform's
  address rather than Archyne's own, which is a thing to fix on the day a
  domain is worth its upkeep, and not before.

### Internal

- The trusted publishers for `archyne` and `archyne-render` are registered
  against the repository's owner, name and workflow filename, so both were
  re-registered against `archyne/archyne` before this version was cut.
  Publishing fails closed if they disagree, which is the desired behaviour and
  also the thing to remember the next time anything moves.

## [0.6.0-alpha.1] — 2026-08-29

### Added

- **Lucidchart files import as flowcharts — the seventh foreign format.** A
  `.lucid` file is a zip holding a `document.json`, the interchange format
  Lucid documents for its own import, and that document on its own is
  accepted too. Shapes, text, colours, connections and their labels, line
  styles, hand-routed corners and the original layout all come across, and a
  file with several pages offers them in the preview and imports whichever
  one is chosen. Lucid groups are selection-grouping rather than containment,
  so their members arrive free; rotation, opacity and image fills have no
  Mermaid counterpart and are counted out.
- **An "Automatic" arrangement, which decides for the file.** Until now
  Arrange spread the picture the way you named, and one named way cannot be
  right for both a flowchart and a network of springs. But the reading of a
  file already knows the answer: every arrangement in the menu is drawn on
  the file, and the one that reads best is kept. "Best" is a ranked score of
  what a reader recognises first — a node sticking out of its own container
  outranks boxes covering each other, which outranks connections drawn on
  top of each other, a line running flush with a border, connections
  travelling across each other, a label lying on a connection it does not
  name, a label hiding its own line, a label over someone's words — and,
  only where two arrangements read equally well, the ground the drawing
  stands on. The parts are ranked rather than weighted because they have no
  honest exchange rate, and the score is arithmetic over what the router and
  the label layers will actually draw, so the same file always picks the
  same arrangement and settles on the same positions. The score lives in
  `src/layout/choose.ts`.
- **The arrangements menu shows its hand.** Each entry draws the shape it
  makes beside the list, and the arrangement the canvas currently sits in is
  ticked — which is how "Automatic" announces which arrangement won. The
  tick is a claim a session makes, not a file's: a document that loads from
  disk (or a sequence diagram, whose geometry it did not choose) ticks
  nothing.
- **The canvas says when it is being rearranged.** The layout engine takes
  its time on a large file, so while it works the canvas carries a progress
  notice — a busy picture coming together, rather than a frozen one.

### Fixed

- **An arrowhead is always at the end of a straight run.** A connection that
  had approached its node from the wrong side used to turn and cut through
  the box it was heading for, come straight back out, and leave its arrowhead
  standing at the end of a spike on the node's border. The two boxes a
  connection joins now count as obstacles like every other — it may touch
  them at the faces it uses, but nothing draws through either box's middle —
  and the legibility suite now _fails_ a diagram whose arrowhead sits on a
  bend, instead of watching and waiting.
- **A connection leaves a spread bunch square-on again.** When the separation
  pass slides a whole corridor of connections sideways, the corner of a run
  one of them _arrived_ on can land on the plane of the node's face; the
  last few units then run along the face itself, and the arrowhead reads as
  arriving sideways. After the corridors have been put back apart, such an
  arrival is squared one more time — a corner slid onto the face's plane is
  pushed back out to a full stub, and the straight run into the face is whole
  again — but only where nothing stands where the stub would go, so a route
  that cannot be rebuilt is left drawn sideways rather than gone.

## [0.5.2-alpha.1] — 2026-08-22

Supersedes `0.5.1-alpha.1`, which carries exactly these changes and was
withdrawn for a packaging mistake of its own. Either one has the fix below;
this is the one with a release page.

### Fixed

- **The macOS app opens.** Every `.dmg` up to and including `v0.5.0-alpha.1`
  was refused by macOS on launch, and nothing a user could do got past it. The
  installers were being built without a valid signature; they now carry one.

  macOS will still ask you to confirm an unidentified developer, because the
  app is not signed with an Apple certificate — but that is a prompt you can
  accept, and the download works. The instructions on the release page have
  been corrected to match.

## [0.5.0-alpha.1] — 2026-08-19

**A crowded diagram is legible again, and so is the strip of tabs under it.**
Five connections leaving one node's underside used to leave from the same
point, so five lines lay on top of each other and the picture said there was
one. Labels sat wherever the middle of a route happened to be, which on an
imported drawing is very often on top of a box's words. Both are now decided
knowing about every other connection on the diagram, and both change what
`archyne-render` draws as well as what the canvas shows — the minor moves for
that, not for anything about the file format.

What Archyne writes has not changed. Nothing under `src/model/kinds/` was
touched and the round-trip suite is unchanged and green: this release moves
where lines are drawn, not what is saved.

Alongside it, the workspace stops hiding itself. Past about eight documents a
tab was a badge and one letter, and the only way to reach the ninth was to go
looking. There is now a list of all of them, and an order you choose.

### Added

- **Every open diagram in one list, in the order you put them.** The tab strip
  shows the tabs that fit; past that it was a scroll and a hunt. There is now a
  list of all of them beside the `+`, with each diagram's family, its unsaved
  mark and the one you are in. Drag a tab along the strip to move it, or reach
  the same thing from the list with Alt and the arrow keys, and the order is
  kept. Or sort the lot by name — numerically, so `Untitled 2` comes before
  `Untitled 10` rather than after it — or by which you used last.

### Changed

- **Connections leaving the same side of a box fan out instead of coinciding.**
  A connection used to meet a box in the middle of whichever face pointed at
  the other end, which is right for one connection and wrong for the second:
  five edges leaving a node's underside all set off from the same point, so
  five lines lay on top of each other and five arrowheads landed in the same
  place. The picture said one connection where there were five, and no amount
  of routing afterwards separates lines that never cross. The face is now
  shared out along its length, in the order the far ends lie, so the lines
  spread without crossing on the way — and a single connection still meets the
  face dead centre.

- **A label moves along its own line rather than sitting on top of something.**
  Put a label in the middle of every route and, on a diagram with a few
  connections, that is the end of it. Import a real drawing and the middle of
  one route is the middle of a box, or of the route beside it, and the label's
  plate hides a node's words or another label. Labels now slide along the line
  they name, which is the one direction that never leaves you wondering which
  connection they belong to; stepping off to the side is a last resort. On a
  crowded diagram there is often nowhere clean at all, so the least bad
  placement wins rather than the first one tried.

- **Tab names stop being squeezed down to nothing.** Past about eight
  documents a tab was a badge, one letter and a close button — the strip
  answered "how many are open" while refusing to say which. Tabs now stop
  shrinking while there is still a name to read, and the strip scrolls
  instead: with the wheel, by dragging a tab to its edge, or with the chevron
  that appears over the end that has more behind it.

### Fixed

- **Switching to a diagram that does not parse no longer shows you the last
  one.** Moving from a diagram that draws to one that is broken or empty left
  the previous picture on the canvas: you were in one document, looking at
  another. Keeping the last good picture is right only while you are typing
  into the diagram already on screen, which is now the only place it happens.
  Everywhere else the canvas says which of empty and broken it is.

- **Unticking "arrowheads at both ends" takes the second arrowhead off.** It
  went on and would not come off again, and the file was right the whole time
  — only the picture disagreed, until the next time the source was re-read.
  The same fault took the back arrow off a C4 birel and cleaned up markers
  left over when a document changes family.

- **The light theme colours Mermaid source the way the dark theme does.** It
  had one colour where the dark theme had five: the keyword naming the diagram
  was green and everything else was plain text.

- **Hovering a tab highlights the tab.** The highlight used to take the shape
  of whichever half of the tab the pointer was over, most visibly a small
  block under the × alone.

## [0.4.1-alpha.1] — 2026-08-13

**Diagrams drawn outside a browser now measure their text properly.** If you
pre-render Mermaid to `.svg` files in a build step, or rewrite a document
server-side, this is the release that makes the words fit the boxes.

### Fixed

- **Text measured without a browser was a guess, and is now a measurement.**
  With no canvas to ask — which is the case in Node, and in jsdom — each
  character was sorted into one of four width classes. Across a sample of
  labels that put the median 4.2% out and the worst case 36%: enough to break a
  line in the wrong place and size a box visibly wrong. Widths now come from a
  table measured from the fonts themselves, one advance per glyph, which is
  exact for a typical label. What is left is kerning, on pairs like the "AV" in
  "AVATAR", and it errs wide, so nothing clips.
- **Bold labels were measured as though they were not bold.** The old width
  classes had no notion of weight at all, so every semibold label came out
  narrower than it draws. Measured faces cover both weights the stylesheet asks
  for.

### Documentation

- **`archyne-render` explains the three ways to plug it in** — a preview that
  runs your script, Node before the page is built, or files written ahead of
  time. They are not three tools but three places the code can run, which is
  what decides whether there is a DOM: VS Code's built-in preview and Markdown
  Preview Enhanced are the same recipe. Each is executed by the test suite
  rather than illustrated, so a recipe that stops working fails a build.
- **What rendering a whole directory costs.** Mermaid keeps one parser database
  per diagram family, so parsing is serialised: `Promise.all` over five hundred
  diagrams is correct and no faster than a loop. The README says so, and says
  that the unit to multiply is the process.

## [0.4.0-alpha.1] — 2026-08-13

**Archyne's renderer is now a package you can install.** `archyne-render` draws
a Mermaid diagram as a self-contained SVG string — real geometry, real text, its
own colours inlined — so the picture survives the page that made it. It is not
an alternative to Mermaid: Mermaid still does the parsing, and this draws what
it parsed, with ELK layout and orthogonal edge routing.

Why it matters: every Markdown preview that draws diagrams bundles a library or
shells out to a binary, and none of them offers a hook where a third-party
extension supplies the renderer. Archyne could only ever be _embedded_ — an
iframe and a `postMessage` protocol. It can now be imported.

What Archyne writes has not changed. A file saved by this release is
byte-identical to one saved by the last.

The rest of the release follows from the same work. Making a picture without a
browser meant a node's size had to be _worked out_ rather than assumed, and the
constants that stood in for it were wrong in ways nothing had ever checked — so
auto-layout, the draw.io import and the SVG export all move with it.

### Added

- **`archyne-render` on npm.** Two entry points, because they cost differently:
  `archyne-render` draws a graph you have already parsed and laid out, and runs
  anywhere JavaScript does — no DOM, no Mermaid, no dependencies at all.
  `archyne-render/mermaid` parses and lays out for you, bringing Mermaid as an
  optional peer and ELK lazily. It draws all seven families Archyne edits, and
  refuses a diagram kind it does not know rather than returning half a picture.

### Changed

- **Exporting to SVG gives you an SVG.** The vector download used to be
  html-to-image's capture of the live page: one enormous `<foreignObject>` full
  of HTML, which opens in a browser and nowhere else — not in an `<img>`, not on
  GitHub, not in Inkscape, not in a PDF tool. It is now geometry and text: shapes as
  `<rect>` and `<path>`, labels as `<text>`, and the colours inlined so nothing
  resolves against the page it lands in. PNG and PDF are unchanged, which is the
  right tool for a raster.

- **Nodes are sized by what is written in them.** The layout engine was being
  handed constants — every state 150×46, every entity and class exactly 210
  wide, whatever they contained — so it reserved room for a diagram other than
  the one on screen. Sizes are measured now, which shows up as auto-layout
  leaving the right gaps rather than approximately right ones.

### Fixed

- **A drawing imported from draw.io is no longer packed too tightly.** The
  import works out how much to stretch the original coordinates by asking how
  much room a service needs, and it asked with a node carrying **no name** — a
  question whose answer was 23px short of the truth for every labelled node in
  the file. Nodes could end up overlapping, and spilling out of the subnet they
  belonged to.

- **A C4 element is the height it should be.** Every one of them reserved room
  for the 26px disc that only a _person_ draws.

## [0.3.2-alpha.1] — 2026-08-11

A patch on the terms 0.3.1 set: **what Archyne writes has not changed.** A file
saved by this release is byte-identical to one saved by the last, and the
`%% graph:` comments hold the same things.

What changed is reach. The VS Code extension no longer needs a `.mmd` file to
be useful — a fenced Mermaid block in a Markdown document is editable where it
sits. That is where most Mermaid in a repository actually is, and until now
none of it could be drawn on a canvas without first being moved out of the
document it belonged to.

The other two entries are the release plumbing catching up with itself: `npx
archyne` was handing out a build from before the import subsystem, and the link
the README gives for desktop installers was resolving to the wrong page.

### Added

- **The VS Code extension reaches Mermaid inside Markdown.** A fenced
  ` ```mermaid ` block in a README, an ADR or a page under `docs/` now carries
  an **Open on canvas** action above it, and what you draw is written back into
  that fence — the rest of the document, and the block's own indentation inside
  a list item, left alone. Most Mermaid is not in a `.mmd` file, and until now
  none of it could be edited visually without being moved out of the document
  it belonged to. The command palette has the same action for the block at the
  cursor, and `archyne.codeLens.enabled` turns the lens off.

### Changed

- **`npm install archyne` and `npx archyne` now give you the current
  release.** They were giving `0.1.0-alpha.1`, the build from before the
  import subsystem, because releases were published under the `next` dist-tag
  and `latest` was never moved off the first one. Releases now publish to
  `latest`; `next` is no longer maintained, so pin a version if you were
  relying on it.

- **The [latest release](https://github.com/dariodd/archyne/releases/latest)
  link resolves to a release** rather than to the list of them, which is where
  the desktop installers are. Releases are no longer flagged as prereleases on
  GitHub — that flag is what excluded them — so read the version itself:
  every release so far is an alpha, and says so in its name.

## [0.3.1-alpha.1] — 2026-08-11

A patch, not a minor, and the distinction is the one 0.3.0 drew: **what
Archyne writes has not changed.** A file saved by this release is
byte-identical to one saved by the last, the `%% graph:` comments hold the
same things, and nothing was added to the format. What changed is where
Archyne runs and what it lets you do with the mouse.

It now runs inside VS Code, on the file the editor already has open, and the
extension is published to both registries. Messages in a sequence diagram can
be dragged between rows and into a `loop` or `alt`. Nodes stop shrinking where
their contents stop fitting rather than at a number that could not know what
they hold. An architecture diagram is laid out along the sides it already
names, instead of downwards past them.

Three of the fixes are the same shape, and worth saying together: something
was stated once in the code and then quietly restated somewhere else, where it
went stale. The version in the About dialog, the version the MCP server gave
its clients, and the rule that a host's diagram never reaches `localStorage`.
Each now has one source.

Still alpha, and the caveats under "What is not done" in the 0.1.0-alpha.1
notes all still hold: unsigned desktop builds, a self-assessed accessibility
report, unreviewed translations, no independent security review.

### Added

- **Archyne runs inside VS Code.** Published as `naxeris.archyne` on the
  [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=naxeris.archyne)
  and on [Open VSX](https://open-vsx.org/extension/naxeris/archyne), which is
  where VSCodium, Cursor, Windsurf, Gitpod and Theia look and which cannot
  install from the first. Open a `.mmd` and pick Archyne, and the canvas opens
  on the file the editor already had.

  It is an optional editor, not a replacement: `.mmd` still opens as text
  unless you ask otherwise, and VS Code keeps owning the document, so the
  dirty dot, undo, save and the diff against `HEAD` are the ones already
  there. The extension never writes to disk itself.

  Inside it, Archyne withdraws the controls that are no longer its own —
  Save, Save as…, Open, Reload from disk, New diagram, Rename, Duplicate and
  the document tabs. The line is not "hide the file menu" but between binding
  to a file and editing the diagram in front of you: templates, import,
  export and everything on the canvas stay, because VS Code saves whatever
  comes out of them. `Ctrl+S` and `Ctrl+O` reach VS Code rather than being
  intercepted — a hidden Save button beside a live `Ctrl+S` would be the same
  contradiction, only harder to see.

- **The embed protocol gained a second transport**, which is what the
  extension is built on. The messages are unchanged — `load`, `getCode`,
  `export` in, `ready`, `change`, `code`, `exported` out — and only the pipe
  differs: inside a webview there is no framing page to answer, and the
  extension host sits behind `acquireVsCodeApi()` instead.

  Pages that embed Archyne in an iframe are unaffected, default-deny origin
  allowlist included. The webview does not carry one and does not need one: it
  is the top document, nothing may frame it, and there is no second candidate
  an allowlist could exclude. What guards it is the extension's
  `localResourceRoots` and the page's own policy.

- **A message is dragged to where it goes, into a loop or out of one.**
  Reordering was two buttons in the inspector moving one row at a time, which
  is a poor way to say "this one happens inside the retry" — and on the canvas
  the arrows were the one thing that could not be picked up and moved. Each
  message now carries a grab strip: drag it and the rows part to show where it
  will land, the frame of the `loop` / `alt` / `opt` it would fall into
  lights up and opens to take it, and dragging past the closing row carries it
  back out.

  Containment is not a second thing to maintain — blocks live in the same
  statement stream as an opening row and a matching `end`, so landing between
  the two _is_ what puts a message inside one. The gesture writes nothing
  until it is dropped, Escape abandons it, and a plain click still selects the
  arrow rather than nudging it, so the strip adds a gesture without taking
  one away.

### Fixed

- **A host's diagram no longer reaches `localStorage`.** "In embed mode the
  host owns the data — never touch localStorage" is a rule the workspace
  states about itself, and it enforced it by looking for `?embed=1`. A VS Code
  webview has no query string to carry that flag, so the check answered no and
  the file was copied into Archyne's own storage — the copy that then showed,
  briefly, the next time it opened. One predicate now answers for both kinds
  of embedding, and the splash is held until the host's document arrives
  rather than another being drawn first.

  A webview is also bound to one document, so the tab strip is gone there for
  a reason that was not cosmetic: switching to a second document sent that
  one's text back as an edit to the file the host still had open.

- **Archyne says which version it is.** The About dialog reported `0.1.0`, and
  had done since that really was the version — through 0.2.0, 0.2.1 and
  0.3.0. The MCP server introduced itself to every client with the same stale
  string, so an agent's logs named a version that had not been current for
  three releases. Both now report the one that shipped.

- **A node stops shrinking where its content stops fitting.** The handles
  stopped at a flat 48×28 for every node in the app, so a box with a 44px icon
  and a two-word name dragged to that size simply cut both off — the floor was
  a single number that could not know what any particular node was carrying.
  It is now measured from the drawn element as the gesture starts, and the
  typed width and height in the inspector are raised the same way, so the two
  controls for one property can no longer disagree.

  The two directions are settled differently, and deliberately. The narrowest
  the content goes is a fixed number, so width gets a hard stop during the
  drag. How _tall_ the content needs to be depends on how wide the box is — a
  label taking four lines at 54px takes one at 250 — so a height stop would
  have to move mid-gesture, and React Flow picks which way to apply a clamp
  from the sign of the vertical travel, which is zero on a horizontal drag:
  a rising `minHeight` there comes out subtracted, and the node ends up with a
  negative height. So height snaps back on release instead, which also leaves
  a wide flat box reachable, since at that width it fits.

- **An architecture diagram is laid out along the sides it already names.**
  `architecture-beta` has no direction statement; what it has is a side on
  every end of every edge, and `web:R --> L:db` says db stands to the right of
  web. Auto-layout ignored those and laid the graph downwards anyway, so the
  edge had to leave rightwards, drop past its target and come back into its
  left face, passing behind the very node it pointed at — the starter diagram
  arrived with its one arrow looking detached, the line ending on one side of
  the box and the arrowhead sitting on the other. The sides were the layout
  all along. The dominant axis decides, because one graph gets one direction,
  and every other family answers that it has stated nothing and keeps the
  direction it came with.

## [0.3.0-alpha.1] — 2026-08-10

A minor bump rather than a patch, for a reason that outlives the feature
list: what Archyne _writes_ changed. Every picture now carries its size and
`constraint: "on"`, a new icon carries `fill:none,stroke:none`, and states,
classes and entities keep the `style` statement they were quietly losing on
save. A file written here is still ordinary Mermaid and still opens in the
version before this one — but it is not byte-for-byte the same file, and a
patch would say nothing had happened.

The work itself is about the two views agreeing. An icon that looked right
on the canvas arrived in the Mermaid Live Editor as a 200×16 smear; a type
size was stored and never drawn; a colour was read, ignored and then written
back out as nothing. Each of those was the canvas and the file telling
different stories, which is the one thing a local-first editor cannot do.

Alongside it, the families were levelled up to each other: every node is
renamed by double-clicking it, labels hold a second line where mermaid
allows one, and the same row of colour controls serves four diagram kinds
instead of one. Where a family genuinely cannot follow —
`architecture-beta` accepts neither `<br>` nor `style` — it is left out and
said so, rather than given something that would write a file it could not
reopen.

Still alpha, and deliberately: the caveats under "What is not done" in the
0.1.0-alpha.1 notes — unsigned desktop builds, a self-assessed accessibility
report, unreviewed translations, no independent security review — are all
still true. This publishes under `next`, as every release since 0.2.0-alpha.1
has.

### Added

- **A loop in a C4 or architecture diagram says what will become of it.**
  Both families accept a connection from a node to itself — it parses, and
  mermaid renders it without complaint — and both then draw an arrowhead and
  a label at the corner of the box rather than a loop. The file is right and
  the canvas here draws the loop, so the edge is made and a note says where
  the two part company. Not a refusal: refusing valid mermaid is not ours to
  do. Not a nag either — it is said when one is drawn, not when a file
  carrying one is opened.

- **Colours and a type size, in every family that can hold them.** Only a
  flowchart shape had anywhere to keep a `style <id> …` statement, so a state
  diagram or a class diagram that arrived with colours was parsed, drawn
  plain, and written back out without them — the file lost what it came with.
  States, classes and entities now read, draw and write their own, through
  the same row of controls rather than four copies of it.

  Which families those are was settled by asking mermaid's parsers, not by
  guessing: `style` is accepted in flowchart, state, class and ER diagrams,
  and `architecture-beta` has no such statement at all — which is why a
  service is not offered the row. C4 has a syntax of its own
  (`UpdateElementStyle`) and is left for its own change rather than bent into
  this one.

- **An icon is asked the same question everywhere.** A flowchart picture had
  a "No frame" tick box and an architecture service a "Look" menu — one
  choice, two spellings. Both are now the menu, in the same words: a box with
  the icon in it, or the icon alone. What reaches the file still differs,
  `fill:none,stroke:none` against the `look` in the graph comment, because
  `architecture-beta` has no `style` to write; the question does not.

- **Every node is renamed by double-clicking it.** It was flowchart shapes
  alone: in the other six families the only way to change a label was to find
  the field in the inspector. States, entities, classes, services, C4
  elements, participants, notes and containers all take the same editor now,
  lifted out of `ShapeNodeView` rather than copied into each of them.

  The field is laid over the words rather than put in place of them: these
  nodes are mostly the size of what they hold, so a field with a width of
  its own is a node that changes shape the moment it is double-clicked —
  which it did, in seven families out of eight. The text stays in the
  layout, unseen, holding the box open, and the field sits on top of it. No
  border either, for the same reason; an outline is drawn without taking
  room.

  A second line comes with it, where mermaid will have one. Its parsers were
  asked rather than assumed: `<br>` is accepted in flowchart, state, class,
  ER, sequence and C4 labels, and rejected outright by `architecture-beta` —
  so a service is renamed one line at a time and Shift+Enter there has
  nothing to do but finish. On a table node it is the title that is typed
  into, not the rows: attributes, members and methods have a syntax of their
  own and the inspector already takes it.

- **A node's label has a type size.** A number in pixels beside the three
  colours, written as `font-size:NNpx` — which is a label style in mermaid's
  own reckoning, so a size chosen here is a size every reader of the file
  draws with. Back at the default the declaration comes out again rather
  than being spelled on every node: 12px written down is 12px nobody chose.

- **Shift+Enter puts a label on a second line.** Mermaid holds a second line
  as `<br>`, which is right for the file — every other tool reading it draws
  two lines too — and wrong for a text field, where it is markup standing
  where a line break should be. Both editors now show the lines and write
  the `<br>`: on the canvas, Enter still ends the rename and Shift+Enter
  makes the line; in the inspector the label field is a proper multi-line
  one, where Enter has nothing to submit and simply makes the line.

  The field takes exactly the room the text takes, at one line or at four,
  so renaming an unframed node — which is the size of what it shows — does
  not make it grow while you type. That cost the field its border, which is
  now an outline: an outline is drawn without taking room.

- **An icon arrives without a frame around it.** Mermaid draws a rectangle
  tight around an image node, taking its fill and border from the node's own
  style, and around a logo that box is noise. Choosing a picture now writes
  `fill:none,stroke:none` — ordinary Mermaid, not a private flag, so the icon
  stands bare in the Live Editor as well as here — and clearing the picture
  takes those back off, since a node with no picture and no frame is a node
  you cannot see. The "Look" menu overrides it either way, and a frame put
  back by hand survives the next edit to the node.

  An unframed picture is also the size of what it shows. A picture does not
  grow the box it is drawn in — that rule stands, and a node's size is the
  author's — but with no frame there is no box, and 160×54 of nothing around
  a 60px logo is not a size anybody chose either: it is where the selection
  outline stood and where the edges arriving at it stopped. So that node
  shrinks onto its picture and its label, the way a bare service node
  already did and the way mermaid draws the same node. Dragging a handle or
  typing a size still wins, and "Auto size" gives the fitted one back.

### Fixed

- **An icon on a flowchart node drew as a smear everywhere but here.** The
  node looked right on the canvas and arrived in the Mermaid Live Editor as
  a 200×16 rainbow bar. Mermaid draws an image shape at the picture's
  _intrinsic_ size, which for an icon set is the `width: 1.25em` in the SVG
  — about 20×16 — and then, whenever the node has a label, widens it to the
  flowchart wrapping width of 200px and stretches it to fit with
  `preserveAspectRatio="none"`. Archyne wrote neither a size nor a
  constraint, on the principle that a file should not carry values nobody
  chose; the principle was right and the conclusion was wrong, because the
  canvas fits every picture with `object-fit: contain` and so does choose
  one. `w`, `h` and `constraint: "on"` are now written for every picture,
  which is what makes Mermaid derive the width from the height and the
  picture's own ratio rather than from the wrapping width. An `icon:` node,
  which Archyne never writes and only hands back, still gains nothing it did
  not arrive with.

- **The canvas ignored every text style but the colour.** `styleProps` read
  five declarations, and mermaid puts eighteen on the label — so a file
  carrying `style a font-size:22px` was parsed, kept, and written back out
  intact while being drawn at 12px like everything else. The type size, the
  weight and the italic are now drawn as well as stored, which is also what
  makes the new field above show its effect rather than only its number.

- **Renaming a node took its picture away while you typed.** The editor
  replaced the whole label block, and the picture was part of it — so a node
  with an icon lost the icon for the length of the rename, and an unframed
  one collapsed to a lone text box floating where the icon had been. The
  field now stands in for the words only, and the picture stays where it is
  — taking exactly the room the name took, since a node with no frame is its
  own contents and a field wider or taller than the text would be a node
  that resized itself the moment you started typing.

- **A connection let go anywhere on a node connects to it.** React Flow
  finishes one only within `connectionRadius` of a connection _point_, and
  that is a distance from a point — so whether the middle of a node counted
  depended on how big the node happened to be. Released dead centre, a
  flowchart box connected and an architecture service, twice the size, did
  not: the same gesture, two answers, for a reason nobody can see. The whole
  node is now a target, as it is in draw.io.

  Not the node it came from, and not a group. With the whole node a target,
  a drag that wandered back over its own node would leave a loop behind, and
  a container covers most of the canvas — every drag ending in open space
  inside one would connect to the container. Both are still reachable by
  their own connection points, which is where meaning to do it looks like
  meaning to do it.

- **One `SideHandles`, not two.** The architecture views kept a private copy,
  identical to the shared component down to the comment above it. Identical
  today; two things that stop being identical the first time either is
  touched — and the shared one had just been touched.

- **The connection points are shown when they are wanted.** Four dots on
  every node, at every moment, sitting over the labels and the icons they
  were meant to serve — on a node drawn as an icon, on top of the icon. They
  now appear on the node under the pointer, on the selected node, and on
  every node while a connection is being dragged, that last because the node
  you are aiming at is nowhere near the pointer when the drag starts.
  Finishing one never depended on hitting a dot: the connection radius is
  38px, so a line released near a node takes its nearest point.

- **An edge from a node to itself toured the diagram.** `bestSides` picks the
  two faces a connection uses by comparing the node centres, and for one box
  against itself every difference is zero — so it answered "leave the bottom,
  arrive at the top", which is a request to get from under the node to above
  it. The router obliged: down past the label, out through the wall of the
  enclosing group, and back up. A loop now uses two _adjacent_ faces and the
  corner between them, so it sits against the top-right of its node, squared
  off and hopped like every other connection here. An architecture diagram
  writes its faces into the file, and a loop takes those when it can —
  `db:B --> L:db` goes round the bottom-left — falling back only when they
  name two opposite faces, which is the request that produced the tour.

- **The colour row held three different heights.** "Reset" carried a rule of
  its own, written before the shared `.mini` existed and left behind when it
  arrived: 11px of dimmed text in a 23px box, next to 29px fields and 26px
  swatches. The row's own rule is gone, so the button is the one used
  everywhere else, and the swatches and the buttons are told the height a
  field in this panel comes out at. Four controls, one line.

- **Three blocks of the inspector sat 12px left of everything else.** The
  panel has no inset of its own — each row carries one, so a colour swatch
  and a text field line up down a single edge — and `.field-hint` and the
  align-and-distribute pane came from the dialogs, where the modal body
  supplies it. The hint under the picture field, and the whole selection
  panel, were flush against the edge of the panel. Every tick box was 4px out
  in the other direction, on the browser's own checkbox margin.

## [0.2.1-alpha.1] — 2026-08-10

Work on the editing surface itself: the source panel becomes an editor you
can size and read, and three defects in how icons behave are fixed — one of
which meant that clicking an icon sometimes did nothing at all.

Still alpha, and deliberately: the caveats under "What is not done" in the
0.1.0-alpha.1 notes — unsigned desktop builds, a self-assessed accessibility
report, unreviewed translations, no independent security review — are all
still true, and a version that lands on `npm i archyne` by default should
not carry them silently. This publishes under `next`, as 0.2.0-alpha.1 did.

There is no 0.2.0 release: that number, along with 0.2.1-rc.0, was taken on
npm by a publishing rehearsal in the days before the repository was
recreated, so the 0.2 line continues at 0.2.1 instead.

### Added

- **The side panel can be resized.** 380px is a reasonable guess and it is
  only ever a guess: a wide diagram wants the canvas, and reading somebody
  else's Mermaid wants the code. The divider between them is draggable, and
  a real `role="separator"` with a value rather than a bare div with a mouse
  handler — arrow keys move it, Home or End put it back, and so does a
  double-click. The width is remembered.

  Fitting that width to the window is left to the stylesheet's `clamp()`
  rather than done by rewriting the stored number on every resize, so a
  panel dragged wide on an external monitor narrows to fit the laptop and is
  itself again when the monitor comes back.

- **The code has a type size, as in any editor.** `Ctrl+=` and `Ctrl+-`,
  `Ctrl+wheel`, or the `A−`/`A+` buttons above the editor; `Ctrl+0` returns
  to the default. It is stored rather than left to the browser's zoom
  because zooming the page also zooms the canvas, and the point is to read
  the code without shrinking the diagram. Three spellings of the same press
  are bound, since on an Italian keyboard `+` is a shifted key and `=` is
  not where a US layout puts it.

- **Formatting, on `Shift+Alt+F` or the Format button.** Deliberately
  whitespace only: indentation per block depth, trailing spaces dropped,
  runs of blank lines collapsed. Mermaid does not care about indentation, so
  a formatter that only touches it cannot change what a diagram draws, while
  one that rewrites statements could — and a formatter that occasionally
  changes your diagram is one nobody dares press twice.

  Block keywords are scoped to the family that defines them: `opt` opens a
  block in a sequence diagram and is a perfectly good node id in a
  flowchart. The output matches what the app's own serializers emit, so
  formatting a file and then dragging a node in it do not produce rival
  diffs, and running it twice changes nothing the second time.

- **The `%% graph:…` sections are folded away by default.** They are how a
  diagram keeps its arrangement in a file that has to stay valid Mermaid:
  written by the app, never edited by hand, and occasionally enormous — a
  single `graph:icons` line can carry a whole imported SVG. Folded rather
  than hidden, into one line that names what it holds, because the file is
  the source of truth and a section you can open is a section you can check.
  Opening it is remembered.

  Every edit made on the canvas replaces the whole document in the editor,
  which discards its folds — and the edit that does so is very often a drag
  rewriting `graph:positions`. The fold is re-applied after each of those,
  so the section does not spring open the first time a node moves.

- **The icon picker says which icon is under the pointer.** A search for
  "postgres" answers with the same logo from four collections, told apart
  only by name, and the name was in a `title` attribute — a second of
  hovering, and nothing at all for the keyboard.

### Fixed

- **Picking an icon sometimes did nothing.** `IconView` draws its SVG
  through `innerHTML`, so every re-render replaced the icon's `<svg>` node —
  and a browser only fires a `click` when the press and the release land on
  a node that is still in the document. Any re-render between mousedown and
  mouseup therefore ate the click: the icon you clicked was not applied, in
  the picker and in the shapes palette both, with no error anywhere. The
  component is memoised and its markup kept stable, and the case is now
  covered by a browser test that clicks the ordinary, fast way — hovering
  first and then clicking quietly avoids the bug and proves nothing.

- **The picker's icons were browser default buttons.** The only rules for
  them were the palette's, so everywhere else they fell through to the
  system button: in a dark interface, a grey slab with a white outset border
  stretched to the full width of its grid column, 197px of chrome around a
  26px icon. The grid is now sized for the dialog it is in rather than
  inheriting a 170px palette's four columns, and "Choose icon…" is drawn
  like the two import buttons beside it instead of being the odd one out.

- **A picture on a flowchart node hung out of its shape.** Mermaid's image
  shape puts a 60px picture and a label inside a box 54px tall, and the
  block holding them had no height to be measured against, so the picture
  spilled 13px out of the top and the label 19px out of the bottom. The
  picture is now fitted into the shape — the shape is not grown around the
  picture, since a node's size is the author's — and a node resized smaller
  than its picture shrinks the picture rather than letting it escape again.
  The button that changes that picture also shows it, which it never did.

- **The shapes palette no longer changes width with the diagram type.** The
  architecture palette gave itself 200px against everyone else's 170, so
  choosing "Architecture" from the kind menu widened the left column and
  shoved the canvas sideways mid-edit. The columns hold still across a
  change that is about the diagram rather than about the window.

- **The icon controls line up with the fields around them.** The inspector
  puts its 12px inset on each field rather than on the panel, and the row of
  icon buttons did not carry it — so it started 12px to the left of every
  input above and below it, and sat flush against the field it belongs to.

## [0.2.0-alpha.1] — 2026-08-10

A minor bump rather than a patch: this adds a whole import subsystem — six
foreign formats, each previewed before it lands — a PDF export path, and a
multi-diagram workspace, which the 0.1.0-alpha.1 notes listed under "what is
not done". Still alpha, and the caveats in that section still stand except
where this release names them fixed.

### Added

- **Line breaks in a label are drawn as line breaks.** A Mermaid label holds
  more than one line as `<br>`, and Mermaid's own parser hands `&` back as
  `&amp;` once a label contains any markup — and the canvas was drawing both
  as characters. A node that should have read "Route53 / Cloudflare / DNS &
  Protezione DDoS" over two lines instead _said_
  `Route53 / Cloudflare<br>DNS &amp; Protezione DDoS` on one. It affected
  hand-written diagrams too, but an import produces such labels by the dozen,
  so every imported diagram looked broken.

  Deliberately not `dangerouslySetInnerHTML`: diagram text is untrusted — it
  comes from files, from imports, and from agents over MCP — so the string is
  split into lines and the handful of named entities decoded, and everything
  else stays literal text.

- **The import preview lets you overrule the family it chose.** Detection is a
  guess: a PlantUML file could be a sequence, class or state diagram, and a
  DOT file could be a graph or a class model. Where a source can be read more
  than one way the preview offers **Read as** and converts again, so the
  choice is made by whoever knows, and seen before it lands.

- **A cloud import keeps the arrangement it was drawn in.**
  `architecture-beta` has no coordinates, so the converter was throwing the
  geometry away and leaving the whole drawing to a layout engine — a wide
  diagram of subnets came back as a tall column with its connections crossing
  it. But Archyne's own `%% graph:positions` comment is read for _every_
  diagram family, not just flowcharts, so the places are kept there and the
  import opens looking like the file it came from. Groups keep their size too;
  a service keeps only its position, because it sizes itself around its own
  name and the box it happened to occupy in draw.io cropped that off.

- **Both preview panes are the same instrument.** The canvas is React Flow,
  which brings wheel-zoom, drag-to-pan and a fit button; the Mermaid rendering
  was one fixed picture in a scroll box with a pair of percentage buttons
  bolted beside it. Switching between the two meant switching how you look at
  things, which is a poor thing to ask of somebody comparing them. The
  rendering now pans and zooms with the same gestures — the wheel zooms about
  the pointer rather than about a corner — and its controls sit where React
  Flow's do and do the same three things.

- **The canvas components no longer reach for the open document.** The
  editor's edge components read `useGraphStore` directly to route a
  connection, which quietly meant _the_ open diagram. That was invisible until
  something else wanted to draw a canvas — the import preview shows a diagram
  that has deliberately not been loaded, so every connection came out missing.
  The graph now arrives through a context: the editor provides none and the
  store is used exactly as before, while a preview provides a static one and
  is read-only by construction, since a static graph has nowhere to put an
  edit. The preview draws with the editor's own router as a result — the same
  orthogonal paths, the same fan-out where several connections share a pair,
  the same hand-routed corners — instead of the stand-in that curved lines
  across the diagram.

- **A cloud drawing is imported as an architecture diagram.** A VPC with
  subnets and a database is not a flowchart, and reading it as one threw away
  the part that makes it legible: the icons. A draw.io file drawn with AWS,
  Azure, GCP or Kubernetes stencils now becomes `architecture-beta`, with the
  stencil turned into one of the 16 600 vendor icons already in the build,
  containers as groups, and each connection anchored on the side the other
  end actually lies — the only layout information that format can hold.

  Two things the grammar insists on, found by looking at the preview rather
  than by reading a specification: `architecture-beta` ids must be lower case,
  and a label takes letters, digits, spaces and underscores and nothing else,
  so `Amazon VPC (10.0.0.0/16)` would otherwise fail the whole document. The
  bracketed detail is dropped and the rest cleaned.

- **The preview shows the canvas, the render and the code.** It opens on a
  read-only Archyne canvas built from the same node components the editor
  draws with — so it is not an approximation of what you will get, it is what
  you will get — with React Flow's own zoom and pan for judging a large
  drawing. Two buttons switch to Mermaid's own rendering and to the generated
  source. The **Read as** control is always shown rather than only when there
  is a choice, because what it decided is worth stating even when it is the
  only option.

- **Every import is previewed before it lands.** A conversion is lossy by
  construction, and it was landing on the canvas before anyone could judge it
  — replacing what was on screen, with the caveats going by in a stack of
  toasts. The importer now runs first and puts its result up: the diagram
  drawn by Mermaid's own renderer, what family it became, the counts, and each
  caveat that applies — pages skipped, elements with no equivalent, a drawing
  that looked like a different sort of diagram. A button flips the pane to the
  generated Mermaid. Cancel costs nothing, because nothing has been placed.

  It covers every route in: the Import action, the fallback file input, and a
  file the desktop shell hands over. A `.mmd` is placed straight away — there
  is no conversion to check, so a dialog would only be in the way.

- **Import is its own action, and the diagram family is read off the file.**
  Converting a `.drawio` was hiding behind **Open**, which was the wrong word
  for it: opening a file means editing it and saving it back, and an import is
  never written back. **Import…** now sits in the overflow menu with its own
  file filters, and Open offers only what Save writes. Content still decides
  what a file is, so Open on a foreign file keeps working rather than
  reporting that it is not valid Mermaid.

  Each importer also chose one target family and stayed there, so a PlantUML
  class diagram was refused and a DOT class model came across as boxes full of
  pipe characters. The three _text_ formats say what they are, so now the
  family is read off the file:

  - **PlantUML class diagrams** become Mermaid class diagrams — classes with
    their fields and methods, `<<interface>>`/`<<abstract>>`/`<<enumeration>>`
    annotations, generics, packages as namespaces, and the extension,
    composition, aggregation and dependency relations with their cardinalities.
  - **PlantUML state diagrams** become `stateDiagram-v2` — states,
    transitions with labels, `[*]` at both ends, `<<choice>>` pseudostates and
    composite states as nested blocks. A composite named by a transition
    before it is opened now _becomes_ that state rather than appearing twice.
  - **Graphviz record labels** become a class diagram. A pipe-separated
    `record` label is how doxygen draws UML, and `dir=back` — its idiom for
    inheritance — is honoured so the arrow does not gain a second head.

  The three _drawing_ formats do not say what they are: draw.io, Visio and
  Excalidraw put every kind of diagram on one canvas. Those still import as
  flowcharts, but a draw.io file is checked for the tell-tale styles and one
  that looks like a sequence, ER or class diagram says so on import instead of
  leaving you to work out why it arrived as boxes.

- **Four more formats can be opened: SQL DDL, PlantUML, Visio and
  Excalidraw.** With draw.io and Graphviz that makes six, all through one
  sniff-and-dispatch point, all producing an ordinary Mermaid document, and
  none of them ever written back to.

  - **SQL DDL** (`.sql`, `.ddl`) becomes an **ER diagram** — the one import
    that is not a flowchart. Tables are entities and columns are typed
    attributes, and a foreign key's cardinality is read off the constraints
    rather than guessed: many at the child end unless the column is unique,
    optional at the parent end when it is nullable, and identifying only when
    the key is part of the child's own primary key. Dialect-agnostic, and
    shallow on purpose — views, triggers, grants and indexes are stepped over,
    so a whole `pg_dump` opens rather than a hand-trimmed excerpt. Constraints
    added afterwards by `ALTER TABLE`, which is how a dump always writes them,
    count the same as inline ones.
  - **PlantUML** (`.puml`, `.plantuml`, `.iuml`, `.wsd`) becomes a **sequence
    diagram**, and only that. PlantUML is a dozen languages behind one pair of
    markers; a class, state or component diagram is refused _by name_ instead
    of being half-converted into something that has to be checked line by
    line. Participants, messages and arrow styles, activation, notes and the
    `alt`/`opt`/`loop`/`par` blocks all come across.
  - **Visio** (`.vsdx`) is read out of its package: shapes and their text, the
    shape each master suggests, literal colours, the `<Connects>` table as
    edges, and the geometry — centres in inches measured up from the bottom of
    the sheet, turned into corners in pixels measured down from the top. This
    is the first format that is not text, so a binary file now travels from
    the picker to the importer as bytes rather than as UTF-8 that has already
    destroyed it.
  - **Excalidraw** (`.excalidraw`) gives up its boxes, ellipses and diamonds
    with the text bound to them, the arrows its bindings name — not the ones
    that merely look attached — frames as containers, and the positions.

- **Graphviz DOT files can be opened.** `.dot` and `.gv`, directed or not,
  `strict` or not. Unlike draw.io there is almost nothing to lose in the
  crossing — DOT describes a graph rather than a drawing, exactly as Mermaid
  does — so nodes, edges, shapes, colours, `rankdir`, edge labels, line styles
  and `cluster_*` containers all come across, while plain subgraphs stay
  invisible as they are in Graphviz. A graph with no coordinates is laid out
  with ELK; one that has been through `dot -Tdot` keeps the positions it
  already has.

  The point is the DOT nobody writes by hand: `terraform graph`,
  `go mod graph`, doxygen, dbt and most build tools emit it, and until now it
  was something you squinted at in whichever viewer was nearest. The grammar
  is small enough to parse properly, so there is a tokeniser and a
  recursive-descent parser rather than regular expressions, which come apart
  on the first quoted brace — and a generated file is full of quoted braces.

- **draw.io files can be opened.** Archyne could read exactly one format,
  which is a hard thing to ask of somebody with a folder of `.drawio` files
  and no way in. `Open` now takes them — both the plain and the compressed
  form, and the `.xml` older versions write — and converts them to a Mermaid
  flowchart: boxes, labels, shapes, colours, connections with their labels and
  line styles, swimlanes and containers as subgraphs, and the geometry, which
  goes into `%% graph:positions` so an imported diagram opens where it was
  drawn instead of being re-laid-out. Hand-routed corners come across too.

  It is a migration and not a mirror, and says so: a file with several pages
  converts the first and tells you, anything with no Mermaid equivalent is
  counted rather than dropped in silence, and the fourteen vertex shapes are
  matched as closely as draw.io's thousands allow. Two details worth their
  own line: node ids are named after the labels, because generated source
  nobody can read defeats the point of importing into Mermaid at all; and a
  pale draw.io fill is given dark text, because those palettes are drawn for
  black-on-white and the labels were otherwise invisible on Archyne's canvas.

  **The file it came from is never written to.** An import arrives unbound —
  no path, no handle — so Save is Save-as into a new `.mmd`, and a `.drawio`
  cannot be replaced by Mermaid its own editor could not open.

- **PDF export, and export straight to the clipboard.** PNG and SVG covered
  the web and the design tool; the formats a diagram is actually filed in —
  a report, a slide deck, something printed — were left to the user to
  convert. Export now offers PDF as a third format: one page, either cut to
  the diagram or centred on A4 or Letter, turned landscape when the diagram
  is wider than it is tall, and never enlarged to fill a sheet it does not
  need. Alongside it, **Copy image** puts the diagram on the clipboard ready
  to paste, and copies the markup instead when the format is SVG.

  The page holds the diagram as a losslessly compressed image at the chosen
  quality, not as vector paths: vector would mean translating the canvas to
  PDF drawing operators and embedding a font subset for every label, and the
  two libraries that do it are together larger than the whole initial bundle.
  3× is 288 dpi and prints cleanly; SVG stays the answer where the artwork
  has to scale without limit. The writer is Archyne's own — no dependency was
  added, and it is fetched only when someone exports a PDF, so the initial
  bundle is unchanged.

- **A multi-diagram workspace.** There was one `graph:code` key in
  localStorage, so opening a second diagram replaced the first and working on
  five meant five browser tabs. Documents now live in their own keys with a
  small index, shown as tabs under the canvas, and an existing single-document
  diagram is migrated on first load. Three things move with the document
  rather than the window: its file binding, its undo history, and the meaning
  of "New diagram" — which used to overwrite what was open.
- Group width and height can be typed in the inspector, so resizing no longer
  requires dragging a handle (WCAG 2.5.7).
- The single-key shortcuts `C` and `?` can be switched off from the overflow
  menu, remembered across sessions (WCAG 2.1.4).
- Opening a file lands in a new document rather than replacing the one on
  screen, unless that one is an untouched scratch.
- The unsaved-changes guard covers every document, not just the one on
  screen.
- **Open files are watched for changes made outside the app.** The MCP server
  writes `.mmd` files straight to disk, so an agent asked to restructure a
  diagram edits the file the editor has open — and the editor kept showing the
  version it read at open time until the next save quietly overwrote the
  agent's work. A changed file now lands on the canvas within a couple of
  seconds, including for documents open in other tabs of the workspace.
  A document with unsaved changes is never overwritten: the change is
  announced and the work stays, with **Reload from disk** in the overflow menu
  as the way to the other version.
- **Edges can be routed by hand.** Selecting an edge puts a handle in the
  middle of each segment; dragging one out of the line makes a corner, which
  can then be moved, double-clicked away, or typed as numbers in the
  inspector. The corners live in their own `%% graph:waypoints` comment,
  keyed by the edge's endpoints rather than by its index — inserting a line
  above an edge renames it, and the corners would otherwise follow the wrong
  connection. Straightening an edge takes the comment out of the file with
  it.
- **Nodes can be resized, not only groups.** Flowchart shapes, sticky notes,
  states, ER entities, classes, architecture services and C4 elements take
  drag handles, width and height fields in the inspector, and an
  **Automatic size** button — resizing is otherwise one-way, since nothing
  about a 300×90 box says what it would have been. The size travels in the
  positions comment beside the coordinates, and only for nodes that were
  resized on purpose: writing every node's measured size would bloat the
  comment and freeze each label at whatever width it happened to render at.
  Notation keeps its own size — a junction is a dot, a fork bar is a bar, and
  a sequence participant's geometry belongs to the overlay.
- **Alignment guides while dragging.** Lines appear as a node lines up with
  another's edge or centre, and the node snaps onto them — including onto
  positions the 12px grid cannot reach on its own. Dragged groups do not
  align to the children they are carrying, and a node inside a group can
  still align to one outside it: this arithmetic is a delta, and a delta
  means the same thing in every coordinate system.
- **Align and distribute.** With two or more nodes selected the inspector
  offers the six alignments and, from three, evens out the gaps along either
  axis. Dragging gets two boxes nearly level; arithmetic gets them level —
  and this is another way to arrange a diagram without dragging anything.

### Changed

- Toasts pause while the pointer is over them or focus is inside, and resume
  with the time each had left rather than restarting (WCAG 2.2.2).
- The canvas region announces the diagram's `accTitle`, its shape in numbers,
  the author's `accDescr`, and where the readable Outline is.

### Fixed

- **Exported diagrams had solid black boxes.** `html-to-image` inlines
  computed styles for HTML elements only and copies no stylesheets, so the
  rule painting node shapes was absent from the capture and every shape fell
  back to the SVG default fill. The export now carries those rules with it,
  read from the live stylesheet so they cannot drift.
- The preview tab grew past the panel that contains it, overlapping the
  inspector and snapping back on the way to another tab.
- The preview reserves its scrollbar's width, so the diagram no longer shifts
  sideways as the scrollbar appears.
- **The editor no longer reports the store's own edits back as typing.**
  Dragging a node rewrites the positions comment, which pushed new text into
  CodeMirror, which called `onChange` — so the store recorded an undo entry
  for an edit nobody made and re-parsed 400ms later. Re-parsing identical
  code is invisible, except that it rebuilds every node from the source: a
  drag started within that window was thrown away mid-gesture.
- **A selection survives the re-parse it triggers.** Any position-only edit
  rewrites the positions comment, which schedules a re-parse; the rebuilt
  nodes came back unselected. Moving a node with the arrow keys therefore
  deselected it a moment later and the next press did nothing.
- **The keyword naming the diagram now meets AA in the light theme.**
  CodeMirror's default colour for it, `#008855`, measured 4.05:1 on the
  active line and 4.18:1 on the editor background, against a 4.5:1 floor —
  so the first line of every document failed. It is `#00704a` now, 5.52:1
  and 5.70:1. It had been that way since the light theme existed;
  `axe-core` 4.13.0 is simply the first version to report it.

### Security

- **Every dependency advisory is closed.** `ip-address` 10.4.0 clears
  GHSA-mwp4-54f8-5fhr, a high reaching the tree through the MCP SDK's
  `express-rate-limit`, which the advisory gate had been failing on;
  `hono` 4.13.1 closes twenty-eight; `dompurify` 3.4.13 the detached-subtree
  XSS; and `mermaid` 11.16.1 five against the renderer — prototype pollution
  through the configuration APIs and architecture diagrams, CSS injection
  into siblings of the diagram, and the XY-chart and radar loops. The gate
  reports no advisories at all, in any severity.
- These are lockfile changes: the ranges in `package.json` already admitted
  every one of them, so an install of this package from the registry
  resolved the fixed versions regardless. What the lockfile governs, and
  what this therefore does change, is the desktop installers and CI.

## [0.1.0-alpha.1] — 2026-08-01

First public release, deliberately labelled alpha: the editor is complete
enough to be useful and the surrounding project is honest about what has and
has not been verified, but nothing here has been exercised by anyone other
than its author.

### The editor

Two-way sync between a canvas and Mermaid source, across seven diagram
families — flowchart, state, ER, class, sequence, `architecture-beta` and C4.
Structural edits regenerate the text; dragging a node rewrites only the
trailing `%% graph:positions` comment, so a diagram stays valid Mermaid that
GitHub, Notion and `mermaid-cli` all render, while hand-arranged layout
survives save, reload and rewrites by an LLM.

Families with no visual editor — `gantt`, `pie`, `mindmap` and the rest —
open read-only rather than being rejected, with the source fully editable.

Also: undo/redo over code snapshots, copy/paste with id remapping, ELK
auto-layout in a web worker, PNG/SVG export, `.mmd` open and save-in-place
through the File System Access API, a command palette, a template gallery,
and roughly 13 000 searchable vendor icons bundled for architecture diagrams.

### Ways to run it

- The hosted demo at <https://archyne.github.io/archyne/>
- `npx archyne`, which serves the build locally with no clone and no
  dependencies of its own
- Desktop builds for Windows, macOS and Linux, attached to this release —
  **not code-signed**; the release page explains what each platform will say
- An embeddable iframe with a default-deny `postMessage` origin allowlist
- An MCP server, so an agent can read and rewrite diagrams as text

### Accessibility

Keyboard operation of the canvas throughout: palette items place nodes,
`C` connects two of them, arrow keys move them. Dialogs trap and restore
focus. An Outline tab lists every node and its connections, because a canvas
conveys structure spatially and that is precisely what a screen reader cannot
recover. Parse errors announce through a live region wherever focus is.

`axe` reports no WCAG 2.2 AA violations across ten surfaces in both themes,
audited in a real browser. A criterion-by-criterion conformance report is
maintained privately and can be shared on request; it is a self-assessment
rather than a signed VPAT, and says why.

### Internationalisation

English, Spanish, Italian, German, Arabic, Simplified Chinese and Japanese.
Catalogues are typed against the English source, so a missing key is a
compile error, and lazily loaded, so the initial bundle grows by ~3 KB
regardless of how many exist. Right-to-left mirrors the chrome; the source
panel and canvas stay left-to-right on purpose. The translations have not
been reviewed by native speakers.

### Security

No backend, no accounts, no telemetry, and no network request of Archyne's
own — `connect-src 'self'` in the Content Security Policy states a real
invariant rather than a hope. Untrusted diagram text is held by two
independent layers, mermaid's sanitizer and the CSP, each verified separately
in a browser on every pull request. The threat model and what is in scope for
a report are in [`SECURITY.md`](SECURITY.md); a fuller architecture note is
maintained privately and can be shared on request.

Supply chain: a CycloneDX SBOM, an advisory gate on production dependencies
that requires written and expiring exceptions, a drift check on the
third-party notices, and npm publishing through trusted publishing, which
attaches SLSA provenance linking the tarball to the commit that produced it.

### What is not done

Named plainly, because an alpha that hides its edges is not an alpha:
desktop builds are unsigned; the accessibility report is a self-assessment
rather than a signed VPAT, and lists four real defects; the translations are
unreviewed; there is no multi-diagram workspace, so `localStorage` holds one
document; and there has been no independent security review.
