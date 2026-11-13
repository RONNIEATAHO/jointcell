# First Turn

A browser-based live quiz MVP. The host creates a quiz, starts a room, and shares its six-digit code or QR link. Participants join from their own browser. The server manages room state, timed first turns, answer access, and speed-based scores.

The project keeps the main pieces separate: `index.html` for page structure, `styles.css` for the interface, `app.js` for browser behavior, and `server.js` for multiplayer rooms and scoring.

The quiz creator has its own page. Participants enter through the **Join a game** page; scanning a room QR link opens that page with the room code prefilled.

## Run it

Install Node.js, install the package dependencies once with `npm install`, then run from this folder:

```powershell
node server.js
```

The `npm start` command runs the same server and is the start command to use on a Node.js hosting service. The app reads the hosting platform's `PORT` environment variable and builds QR links from the public request origin.

## Deploy the full app

GitHub Pages can display the static interface, but it cannot run the Node.js API used to create rooms, generate QR codes, and handle answers. To run the complete quiz, deploy this repository as a Node web service. The included `render.yaml` configures the build and start commands for Render. Connect the `jointcell` repository in Render and deploy the Blueprint; use the resulting `onrender.com` URL for the host and participants. Render's Node service deployment steps are in its [official guide](https://render.com/docs/deploy-node-express-app).

Open `http://localhost:3000` on the host computer. Participants on the same Wi-Fi can scan the host's QR code or open the local network address shown by the server. If Windows Firewall asks, allow Node.js on the private network so other devices can reach the room.

Keep the Node server running while using the quiz. Opening `index.html` directly skips the server, so room creation and multiplayer controls cannot work.

Install the dependencies once with `npm install`. QR codes are generated locally by the server, with high error correction and a quiet border; no online QR image service is needed.

## Current MVP behavior

- The host writes questions, four answers, the correct answer, a per-question duration, and whether the question has an exclusive first turn.
- The host chooses any not-yet-asked question, assigns a participant when that question has an exclusive first turn, and opens it. Questions can be asked in any order.
- On an exclusive first turn, the assigned learner gets one locked attempt. A correct answer locks the question; an incorrect answer opens it to the rest of the room immediately, with the assigned learner excluded.
- Correct answers earn up to 1,000 points, with points decreasing as time runs out.
- Hosts can import text-based PDFs in the browser. The importer recognizes numbered questions, four A–D choices, inline `Answer: B` lines, or an `Answer Key` section with one numbered answer per line. Imported questions are editable; missing answer keys are flagged for review. Scanned/image-only PDFs and unusual layouts need OCR or manual editing.
- Participant answer tiles use four distinct colors. After answering, a participant sees whether their answer was correct and their points. When a question closes, the room sees the correct answer and response counts; the host also sees the submitted responses.
- PDF parsing uses Mozilla PDF.js loaded from jsDelivr. The PDF contents are processed in the host's browser and are not sent to the quiz server.
- Rooms and scores live in server memory and are cleared when the server restarts. Persistent quizzes, teacher accounts, and deployment are not included yet.
