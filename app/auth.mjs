import { createHash } from "node:crypto";

export function emailAddress(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      email,
    )
    ? email
    : null;
}

// Google's documented authorization-code flow. Only a verified UserInfo email
// and provider-stable subject identify the owner; tokens are never persisted.
export function googleProvider(
  { clientId, clientSecret, origin },
  fetcher = fetch,
) {
  const callback = origin + "/auth/google/callback";
  return {
    authorize(state, verifier) {
      return (
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: callback,
          response_type: "code",
          prompt: "select_account",
          scope: "openid email profile",
          state,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        })
      );
    },
    async identity(code, verifier) {
      const response = await fetcher("https://oauth2.googleapis.com/token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callback,
          code,
          code_verifier: verifier,
        }),
      });
      const grant = await response.json();
      if (!response.ok || !grant.access_token)
        throw new Error("Google sign-in failed.");
      const infoResponse = await fetcher(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: { Authorization: "Bearer " + grant.access_token },
        },
      );
      const info = await infoResponse.json();
      const email = emailAddress(info.email);
      if (
        !infoResponse.ok ||
        !info.sub ||
        info.email_verified !== true ||
        !email
      )
        throw new Error("Use a Google account with a verified email address.");
      return { id: "google:" + info.sub, email, name: info.name || email };
    },
  };
}
