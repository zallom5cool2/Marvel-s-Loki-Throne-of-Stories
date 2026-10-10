# Avengers Protocol

## Play on this computer

Open `index.html` in a modern browser. Enter `2043`, choose a hero, enter a name, then deploy.

## Play online with friends

This project now serves the game page and multiplayer server from one address. The game needs to be published on a Node.js web host that supports WebSockets; GitHub Pages alone cannot run the multiplayer server.

### Quickest publish path

1. Put this entire project folder in a GitHub repository. Keep `render.yaml`, `index.html`, `server.js`, and `package.json` at the repository root.
2. On Render, choose **New → Blueprint**, connect that repository, and deploy. Render reads `render.yaml` and starts the game plus room server together.
3. Open the Render website address. Click **Online Co-op**, leave the server address blank, and enter password `2043`.
4. One player clicks **Create Room** and shares the room code. Friends open the same website, enter `2043` and the code, then click **Join Room**.
5. Everyone selects a character and clicks **Ready**. The host starts the mission.

The room supports up to three players. Hosted games use secure WebSockets automatically when the page is opened over HTTPS. The access code is a convenience gate, not secure authentication; anyone who knows the code and site can try to join.

### Run the server locally

Install Node.js 18 or later, open a terminal in this folder, then run `npm install` followed by `npm start`. Visit `http://localhost:8787`. This local address is only reachable from your own computer; friends on the internet need the hosted website.

## Current verification

`npm test` runs the server tests. Browser gameplay and a public, multi-device internet session still need to be tested after deployment. No public server is deployed by this source package.
