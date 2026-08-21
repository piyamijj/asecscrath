# Red John Scratch Card

An interactive, single-page scratch-off tribute built with plain HTML, CSS, and JavaScript — no backend, no build step.

Scratch away the photo of Patrick Jane and Teresa Lisbon in the CBI office to reveal what's hiding underneath: Red John's calling card.

## How it works

- A `<canvas>` element is drawn on top of a hidden image, filled with an opaque copy of the front "cover" photo.
- Dragging with a mouse or a finger erases the canvas using `destination-out` compositing with a soft, feathered radial brush, so it looks like real scratching rather than a hard-edged mask.
- The script continuously estimates how much of the canvas has been scratched away.
- Once about 55% of the card is scratched, or the player scratches directly over the emblem's center, a one-time "Voilà" payoff fires: a short reveal sound plays and the rest of the hidden image fades in with a brief flourish.
- The layout is fully responsive and works on both desktop and mobile (touch) viewports.

## Project structure

```
index.html    Markup and page structure
style.css     Theming, layout, and animations
script.js     Canvas scratch-off logic and reveal payoff
assets/
  cover-front.jpg      Front/cover layer (CBI office photo)
  red-john-hidden.jpg  Hidden layer (Red John emblem)
  voila-reveal.mp3     Reveal sound effect
```

## Running it locally

No build tools or dependencies are required. Just serve the folder with any static file server and open it in a browser, for example:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000` in your browser.

## Credits

- Sound effect: a royalty-free "Ta-Da" clip, licensed under Attribution 3.0.
- Images are used for fan-made, non-commercial purposes. This project is not affiliated with or endorsed by the makers of *The Mentalist*.