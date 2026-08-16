import { DestroyButton } from "./destroy-button";

export default function Page() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1>A perfectly ordinary page</h1>
      <p>
        Everything here is real DOM. RageLayer captures it into a canvas, hides the original, and
        lets the visitor take the copy apart.
      </p>
      <DestroyButton />
    </main>
  );
}
