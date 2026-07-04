use keyring::{Entry, Error as KeyringError};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Serialize};

const GITHUB_KEYRING_SERVICE: &str = "perfexa.github";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubArchiveRequest {
    account: String,
    api_base_url: String,
    owner: String,
    repo: String,
    ref_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHubArchiveResponse {
    archive_name: String,
    source_label: String,
    bytes: Vec<u8>,
}

fn keyring_entry(account: &str) -> Result<Entry, String> {
    let account = account.trim();
    if account.is_empty() {
        return Err("GitHub credential account is required.".to_string());
    }

    Entry::new(GITHUB_KEYRING_SERVICE, account).map_err(|error| error.to_string())
}

fn github_token(account: &str) -> Result<String, String> {
    keyring_entry(account)?
        .get_password()
        .map_err(|error| match error {
            KeyringError::NoEntry => "No GitHub token has been saved for this account.".to_string(),
            other => other.to_string(),
        })
}

fn non_empty(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required."));
    }
    Ok(trimmed.to_string())
}

fn archive_url(request: &GitHubArchiveRequest) -> Result<reqwest::Url, String> {
    let mut url =
        reqwest::Url::parse(request.api_base_url.trim()).map_err(|error| error.to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("GitHub API URL must start with https:// or http://.".to_string());
    }

    let owner = non_empty(&request.owner, "Owner")?;
    let repo = non_empty(&request.repo, "Repository")?;
    let ref_name = non_empty(&request.ref_name, "Ref")?;

    url.path_segments_mut()
        .map_err(|_| "GitHub API URL cannot be used as a base URL.".to_string())?
        .extend([
            "repos",
            owner.as_str(),
            repo.as_str(),
            "zipball",
            ref_name.as_str(),
        ]);

    Ok(url)
}

#[tauri::command]
fn has_github_token(account: String) -> Result<bool, String> {
    match keyring_entry(&account)?.get_password() {
        Ok(_) => Ok(true),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_github_token(account: String, token: String) -> Result<(), String> {
    let token = non_empty(&token, "GitHub token")?;
    keyring_entry(&account)?
        .set_password(&token)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_github_token(account: String) -> Result<(), String> {
    match keyring_entry(&account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn download_github_archive(
    request: GitHubArchiveRequest,
) -> Result<GitHubArchiveResponse, String> {
    let token = github_token(&request.account)?;
    let url = archive_url(&request)?;
    let archive_name = format!("{}-{}.zip", request.repo.trim(), request.ref_name.trim());
    let source_label = format!(
        "{}/{}/{}",
        request.owner.trim(),
        request.repo.trim(),
        request.ref_name.trim()
    );

    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Perfexa"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    headers.insert(
        "X-GitHub-Api-Version",
        HeaderValue::from_static("2022-11-28"),
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|error| error.to_string())?,
    );

    let response = reqwest::Client::new()
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = body.lines().next().unwrap_or("").trim();
        return Err(if detail.is_empty() {
            format!("GitHub archive download failed with HTTP {status}.")
        } else {
            format!("GitHub archive download failed with HTTP {status}: {detail}")
        });
    }

    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    Ok(GitHubArchiveResponse {
        archive_name,
        source_label,
        bytes: bytes.to_vec(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            has_github_token,
            save_github_token,
            clear_github_token,
            download_github_archive
        ])
        .run(tauri::generate_context!())
        .expect("error while running Perfexa");
}
