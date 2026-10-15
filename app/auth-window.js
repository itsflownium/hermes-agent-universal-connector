// OAuth finishes here on Nectit's own origin, never on an imitation provider form.
const result = document.querySelector(
  'meta[name="nectit-auth-result"]',
).content;
const provider = document.querySelector(
  'meta[name="nectit-auth-provider"]',
).content;
const title = provider === "google" ? "Google" : "GitHub";
const messages = {
  success: ["You’re signed in.", "Returning to your Nectit workspace…"],
  cancelled: ["Sign-in cancelled.", "You can close this window and try again."],
  configuration: [
    `Connect ${title} to Nectit.`,
    `This Nectit server needs a registered ${title} OAuth app before it can open the real sign-in screen. Add its client ID and client secret to your private local environment file, then restart the router.`,
  ],
  failed: [
    "Sign-in couldn’t finish.",
    "The provider could not verify this sign-in. Close this window and try again.",
  ],
};
const [heading, explanation] = messages[result] || messages.failed;
document.querySelector("h1").textContent = heading;
document.querySelector("#explanation").textContent = explanation;
const button = document.querySelector("#return");
button.addEventListener("click", () => {
  if (window.opener) window.close();
  else location.assign("/setup/account");
});
async function complete() {
  if (result === "success") {
    const response = await fetch("/local/bootstrap");
    const profile = await response.json();
    if (!response.ok || !profile.signedIn) return;
    if (window.opener) {
      window.opener.postMessage(
        { type: "nectit-auth", result: "success", provider },
        location.origin,
      );
      window.close();
    } else
      location.replace(
        profile.setupComplete ? "/w/" + profile.slug : "/setup/address",
      );
  } else if (window.opener)
    window.opener.postMessage(
      { type: "nectit-auth", result, provider },
      location.origin,
    );
}
void complete();
