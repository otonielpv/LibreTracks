//! Reading the OAuth redirect, whichever way it arrives.
//!
//! Desktop catches it as an HTTP request on a loopback socket; mobile receives
//! it as a deep link into a private URI scheme. Both end up holding a URL with
//! the same query string, so the part that decides what it means lives here and
//! is tested once for both.

use url::Url;

use crate::CloudError;

/// What Google sent back on the redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedirectParams {
    pub code: String,
    pub state: String,
}

/// Pull `code` and `state` out of a redirect URL.
///
/// Returns [`CloudError::Cancelled`] when the user declined the consent screen,
/// which Google reports as `error=access_denied`. That is a normal outcome and
/// must not read as a failure.
pub fn parse_redirect_url(url: &Url) -> Result<RedirectParams, CloudError> {
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => return Err(CloudError::Cancelled),
            _ => {}
        }
    }

    match (code, state) {
        (Some(code), Some(state)) => Ok(RedirectParams { code, state }),
        _ => Err(CloudError::Network(
            "the redirect carried no authorization code".into(),
        )),
    }
}

/// Same, from a string.
///
/// Mobile hands over a whole URL in the app's private scheme, e.g.
/// `com.googleusercontent.apps.123-abc:/oauth2redirect?code=…&state=…`. The
/// `url` crate parses that fine — the scheme is arbitrary as far as it cares.
pub fn parse_redirect_str(raw: &str) -> Result<RedirectParams, CloudError> {
    let url = Url::parse(raw).map_err(|e| CloudError::Network(e.to_string()))?;
    parse_redirect_url(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_private_scheme_redirect_yields_code_and_state() {
        let params = parse_redirect_str(
            "com.googleusercontent.apps.809304051758-abc:/oauth2redirect?code=4/0AY&state=xyz",
        )
        .unwrap();
        assert_eq!(params.code, "4/0AY");
        assert_eq!(params.state, "xyz");
    }

    /// Authorization codes contain `/` and `+`, and Google percent-encodes
    /// them. Redeeming a still-encoded code fails with an opaque invalid_grant.
    #[test]
    fn percent_encoded_values_are_decoded() {
        let params =
            parse_redirect_str("myapp:/cb?code=4%2F0AY0e-a%2Bb&state=s%2Fx").unwrap();
        assert_eq!(params.code, "4/0AY0e-a+b");
        assert_eq!(params.state, "s/x");
    }

    #[test]
    fn declining_the_consent_screen_reads_as_a_cancel() {
        assert!(matches!(
            parse_redirect_str("myapp:/cb?error=access_denied&state=xyz"),
            Err(CloudError::Cancelled)
        ));
    }

    #[test]
    fn a_redirect_missing_the_state_is_refused() {
        assert!(matches!(
            parse_redirect_str("myapp:/cb?code=abc"),
            Err(CloudError::Network(_))
        ));
    }

    #[test]
    fn a_url_that_will_not_parse_does_not_panic() {
        assert!(parse_redirect_str("").is_err());
        assert!(parse_redirect_str("not a url at all").is_err());
    }
}
