# Mock servers

`node server.js` starts two local servers, no dependencies:

| Port | Role |
| --- | --- |
| `127.0.0.1:35001` | The AWS VPN Client's local SAML listener. Any request returns the real "Authentication successful" page the client leaves open. Logs whether a SAML assertion was delivered. |
| `127.0.0.1:4545` | Mock IdP. `/auto` = valid session (instantly auto-POSTs a fake assertion to `:35001`). `/login` = expired session (interactive form; submitting hands off to `:35001`). |

## Scenarios

```bash
# 1. Valid session re-auth (the "tab avalanche" case)
open http://127.0.0.1:4545/auto
# expected: tab redirects to 127.0.0.1:35001, mock logs
# "SAML assertion DELIVERED ✓", tab closes itself.

# 2. Direct success page (tab left open by an earlier auth)
open http://127.0.0.1:35001/
# expected: closes itself.

# 3. Expired session (VPN genuinely needs you)
open http://127.0.0.1:4545/login
# expected: tab stays while you "sign in" (submit the prefilled form),
# then closes after the success page loads.
```
