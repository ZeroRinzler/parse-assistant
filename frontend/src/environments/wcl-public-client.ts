// WCL OAuth client used for the client-credentials grant, shared by every environment
// file so a rotation is a single edit.
//
// INTENTIONAL SECRET EXPOSURE: this secret ships inside the static JS bundle and is
// therefore public. That is a deliberate design choice. The client-credentials token
// only grants access to public WCL report data - there is no private data behind it and
// no per-user budget to lose. The sole risk is that someone extracts the secret and
// drains our shared hourly rate-limit budget. Mitigation is manual: regenerate the
// secret at warcraftlogs.com/api/clients/ and redeploy (WCL exposes no API to rotate a
// secret, so this cannot be automated). See the project notes on this trade-off.
export const WCL_PUBLIC_CLIENT_ID = 'a21cf850-4cf8-4591-b3e5-906aba0da145';
export const WCL_PUBLIC_CLIENT_SECRET = 'ZYBFec16gC0CfwaunQjSAwUCQwEXTKOFo5JkwSze';
