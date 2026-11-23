//! What can go wrong talking to Planning Center, as the UI shows it.
//!
//! Serializable with a `code` the frontend translates. Never carries a token,
//! a header or a response body with lyrics: at most Planning Center's own
//! short error detail.

use libretracks_cloud::CloudError;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum PcoError {
    /// This build has no client id: Planning Center is not offered.
    #[error("Planning Center is not configured in this build")]
    NotConfigured,
    /// Never connected, revoked, or the refresh token died: connect again.
    #[error("the Planning Center account is not connected")]
    SignedOut,
    /// The user has no access to Services in their organization (403
    /// "The authenticated user was not found in the application").
    #[error("the user has no access to Planning Center Services")]
    NoServicesAccess,
    #[error("not found in Planning Center")]
    NotFound,
    /// Two 429 in a row.
    #[error("Planning Center asked to wait {retry_after_secs} s")]
    RateLimited {
        #[serde(rename = "retryAfterSecs")]
        retry_after_secs: u64,
    },
    #[error("network error: {message}")]
    Network { message: String },
    /// Any other answer: status and Planning Center's own short detail.
    #[error("Planning Center returned HTTP {status}: {detail}")]
    Provider { status: u16, detail: String },
    /// The answer was not the JSON we expected.
    #[error("unexpected answer from Planning Center: {message}")]
    Unexpected { message: String },
}

impl From<CloudError> for PcoError {
    fn from(error: CloudError) -> Self {
        match error {
            CloudError::NotConnected => PcoError::SignedOut,
            CloudError::Network(message) => PcoError::Network { message },
            CloudError::Provider { status, body, .. } => PcoError::Provider {
                status,
                detail: short_detail(&body),
            },
            other => PcoError::Network {
                message: other.to_string(),
            },
        }
    }
}

/// Planning Center's `errors[0].detail` (or `title`), at most 200 characters.
pub(crate) fn short_detail(body: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let error = &parsed["errors"][0];
    let detail = error["detail"]
        .as_str()
        .or_else(|| error["title"].as_str())
        .or_else(|| parsed["error_description"].as_str())
        .or_else(|| parsed["error"].as_str())
        .unwrap_or("");
    detail.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_a_code_for_the_ui() {
        let json = serde_json::to_value(PcoError::RateLimited { retry_after_secs: 3 }).unwrap();
        assert_eq!(json, serde_json::json!({ "code": "rateLimited", "retryAfterSecs": 3 }));
        let json = serde_json::to_value(PcoError::NoServicesAccess).unwrap();
        assert_eq!(json, serde_json::json!({ "code": "noServicesAccess" }));
    }

    #[test]
    fn keeps_only_the_short_detail_of_a_body() {
        let body = r#"{"errors":[{"status":"403","title":"Forbidden","detail":"The authenticated user was not found in the application"}]}"#;
        assert_eq!(
            short_detail(body),
            "The authenticated user was not found in the application"
        );
        assert_eq!(short_detail("<html>no json</html>"), "");
        assert_eq!(short_detail(&format!(r#"{{"errors":[{{"detail":"{}"}}]}}"#, "x".repeat(500))).len(), 200);
    }
}
