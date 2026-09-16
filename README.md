# FlowBatch: bulk generator for Google Flow

FlowBatch is a Chrome side-panel extension. It runs a queue of 20–30+ prompts in
[Google Flow](https://flow.google.com/), one prompt at a time. For each prompt it attaches the
reference images mentioned in the prompt, types the prompt, and submits it. Then it waits until
Flow finishes (or reports an error), downloads the result, and moves on to the next prompt.
It also includes a frame extractor that saves an image from a video every N seconds.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this `FlowBatch` folder.
3. Pin the extension, then click its icon. The panel opens on the right side of the window.
4. Open a Google Flow tab. If Flow was already open before you installed the extension, reload that tab once.

After you edit any file, click **Reload** on the extension card and reload the Flow tab.

## Typical workflow (video → anime frames)

1. **Frame extractor** (expand the card): choose the video — a small preview player appears so you can scrub to the part
   you want — and set **Interval** (for example, `0.5` saves 2 frames per second). Set the prefix to `f_` and the start
   number to `1`, then click **Extract frames**. The frames are added to **Upload assets** as `f_001`, `f_002`, and so on.
   Tick *Save frames to Downloads* if you also want the frames saved as files.
   *Screenshot tab* mode instead captures the active tab every N seconds (at most 2 captures per second).
   After a run, **⤓ ZIP…** packs the frames into one archive and **Clear frames** throws the whole batch away
   (including the assets it created) for a clean slate.
2. **Prompt input**: write the conversion prompt once, using `{asset}` (or a single `@f_001`)
   where the image goes:
   ```
   Convert this {asset} image into a high-quality 2D anime illustration ...
   ```
   Click **⚡ One prompt per asset**. This creates one prompt per frame, separated by `###`.
3. Pick **Image**, the aspect ratio, the model, and the number of outputs (x1–x4). Enter a project name; it becomes the download folder name.
4. Click **Start**. Each result is saved to
   `Downloads/<Base folder>/<Project name>/001_f_001.png`, `002_f_002.png`, …

Other ways to add images: drag and drop them, browse for files, or **Choose folder instead**. Rename an image in its card
and every `@mention` of it in your prompts is updated. Type `@` in the prompt box to pick an image from a list.
Press `Ctrl + Enter` to insert a separator.

## Downloading a batch as one ZIP

Three cards offer **⤓ Download as ZIP…**: *Upload assets* (any image in the panel), *Frame extractor* (the frames from
the last run, even if you did not add them to assets), and the summary at the end of a run (*Download results as ZIP*,
read straight from the Flow tab, so keep it open).

Each opens a picker where every image starts ticked. Untick anything you do not want — or use **All / None / Invert** —
name the archive, and press **Download ZIP…**. Chrome's *Save as* dialog then lets you put it wherever you like, instead
of the usual `Downloads/<Base folder>/` path. Files are stored, not compressed, because PNG, JPG and MP4 already are.

## Video from generated images (sequential frames)

Flow's *Frames to video* mode animates between a **start frame** and an **end frame**. FlowBatch can drive that in bulk:

1. Run your image queue as usual.
2. In the summary, press **🎬 Use these N images for video**. The results are re-imported as assets `pic_001`,
   `pic_002`, … and the panel switches to **Video** with **Sequential frames** ticked.
3. Write one video prompt, then press **🎬 One prompt per frame pair**. Images are paired off in order —
   `pic_001 → pic_002`, `pic_003 → pic_004`, and so on — and you get one prompt per pair.
   Use `{start}` and `{end}` in the template to place the mentions yourself; otherwise they are put at the front.
4. Press **Start**. FlowBatch confirms the plan first, then for each scene puts the first @mention in the start-frame
   slot and the second in the end-frame slot.

**Odd number of images:** the last image has no partner. That one scene cannot use start/end frames, so FlowBatch
switches Flow to **Ingredients to video** for it and uses the single image as an ingredient. You are told which scenes
this affects in the confirmation dialog before anything is generated, both when the prompts are built and again at
**Start**. Queue rows are tagged `FRM` or `ING` so you can see which mode each scene will use.

If Flow's start/end slots cannot be found, FlowBatch attaches the two images in order instead and says so in the log —
you can also point at the slots by hand in **Settings → Flow elements**.

## How "wait for it, then move on" works

For each prompt, FlowBatch:
1. removes old reference chips from the prompt box (optional),
2. uploads each `@mentioned` image through Flow's own file input,
3. types the prompt (by default the `@name` is removed from the text: "Convert this image into…"),
4. records every image or video already on the page, then clicks Create,
5. checks the page every *Poll* seconds for new images or videos, progress indicators (`%`, spinners), and error messages
   ("failed", "couldn't generate", "violates policy"…),
6. marks the prompt **success** once the expected number of new results has loaded and nothing is still in progress,
   or **failed** on an error message or after the *timeout*. Then it waits *Delay between prompts* before the next one.

Failed prompts can be retried automatically (*Retries per prompt*), one at a time with **↻**, or all together with
**Regenerate failed images**. **Pause** lets the current prompt finish and then stops; **Resume** continues from there.
**Stop** cancels the current prompt and puts it back in the queue. Your queue, prompts, assets and settings are
kept when you close the panel.

## If Flow's layout changes

Google changes Flow's interface often, so FlowBatch locates buttons with flexible matching instead of fixed element
IDs. If a step fails (see **Activity log**):

1. Open a Flow project, then go to **Settings → Flow elements → Diagnose current Flow tab** to see what was detected.
2. Click **Pick** next to *Prompt box*, *Submit button*, *Add image button*, *Generation settings button*, or the
   *Start frame slot* / *End frame slot* used by sequential video, then click that element on the Flow page.
   The saved selector overrides automatic detection.
3. **Test** highlights the element that will be used.
4. If mode, ratio, model or count can't be found, the log says so and the run continues. Set those options once by hand
   in Flow, or turn off *Apply mode / ratio / model / count in Flow*.

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (side panel, downloads, content scripts for `flow.google.com`) |
| `background.js` | Opens the side panel when the toolbar icon is clicked |
| `content/page-hook.js` | Main-world hook: catches Flow's file-picker call so images can be uploaded without the OS dialog opening |
| `content/dom.js` | Element finders, clicking and typing helpers, result/progress/error detection, element picker |
| `content/flow-agent.js` | Actions the panel calls: `attachImage`, `setPrompt`, `submit`, `poll`, `applySettings`, … |
| `sidepanel/js/runner.js` | Queue loop: upload → type → submit → wait → download → delay |
| `sidepanel/js/frames.js` | Video frame extraction and timed tab screenshots |
| `sidepanel/js/zip.js` | ZIP writer (stored entries, ZIP64 when an archive needs it) |
| `sidepanel/js/zip-ui.js` | The "pick what goes in the ZIP" sheet |
| `sidepanel/js/*-ui.js`, `main.js` | Panel UI |
