#!/bin/sh
set -e

REPO="qwrobins/linear-cli"
INSTALL_DIR="${LINEAR_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="linear"

main() {
  os=$(detect_os)
  arch=$(detect_arch)
  artifact="linear-${os}-${arch}"

  if [ -z "$LINEAR_VERSION" ]; then
    version=$(latest_version)
  else
    version="$LINEAR_VERSION"
  fi

  if [ -z "$version" ]; then
    echo "Error: could not determine version to install" >&2
    exit 1
  fi

  base_url="https://github.com/${REPO}/releases/download/${version}"
  url="${base_url}/${artifact}"
  checksums_url="${base_url}/checksums.txt"

  echo "Installing linear ${version} (${os}/${arch})..."
  echo "  From: ${url}"
  echo "  To:   ${INSTALL_DIR}/${BINARY_NAME}"

  mkdir -p "$INSTALL_DIR"

  # Download binary
  download "$url" "${INSTALL_DIR}/${BINARY_NAME}"

  # Verify checksum
  checksums_file=$(mktemp)
  if download "$checksums_url" "$checksums_file" 2>/dev/null; then
    verify_checksum "${INSTALL_DIR}/${BINARY_NAME}" "$artifact" "$checksums_file"
    rm -f "$checksums_file"
  else
    rm -f "$checksums_file"
    echo "Warning: could not download checksums, skipping verification" >&2
  fi

  chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

  # Remove macOS quarantine attribute so Gatekeeper doesn't block unsigned binary
  if [ "$os" = "darwin" ] && command -v xattr > /dev/null 2>&1; then
    xattr -d com.apple.quarantine "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null || true
  fi

  echo "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo "Add ${INSTALL_DIR} to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
}

download() {
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget > /dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "Error: curl or wget is required" >&2
    exit 1
  fi
}

verify_checksum() {
  binary_path="$1"
  artifact_name="$2"
  checksums_file="$3"

  expected=$(grep "$artifact_name" "$checksums_file" | awk '{print $1}')
  if [ -z "$expected" ]; then
    echo "Warning: no checksum found for ${artifact_name}, skipping verification" >&2
    return 0
  fi

  if command -v sha256sum > /dev/null 2>&1; then
    actual=$(sha256sum "$binary_path" | awk '{print $1}')
  elif command -v shasum > /dev/null 2>&1; then
    actual=$(shasum -a 256 "$binary_path" | awk '{print $1}')
  else
    echo "Warning: sha256sum/shasum not found, skipping verification" >&2
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    echo "Error: checksum mismatch" >&2
    echo "  Expected: ${expected}" >&2
    echo "  Actual:   ${actual}" >&2
    rm -f "$binary_path"
    exit 1
  fi

  echo "  Checksum verified."
}

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)
      echo "Error: unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      echo "Error: unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

latest_version() {
  api_response=$(mktemp)

  if command -v curl > /dev/null 2>&1; then
    http_code=$(curl -sL -w "%{http_code}" "https://api.github.com/repos/${REPO}/releases/latest" -o "$api_response")
  elif command -v wget > /dev/null 2>&1; then
    wget_headers=$(mktemp)
    wget -S -O "$api_response" "https://api.github.com/repos/${REPO}/releases/latest" 2>"$wget_headers" || true
    http_code=$(awk '/^  HTTP\/|^HTTP\// { code=$2 } END { print code }' "$wget_headers")
    rm -f "$wget_headers"
    if [ -z "$http_code" ]; then
      http_code="000"
    fi
  else
    echo "Error: curl or wget is required" >&2
    exit 1
  fi

  if [ "$http_code" != "200" ]; then
    echo "Error: failed to fetch latest release (HTTP ${http_code})" >&2
    echo "  Check that ${REPO} has at least one published release." >&2
    rm -f "$api_response"
    exit 1
  fi

  tag=$(grep '"tag_name"' "$api_response" | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
  rm -f "$api_response"

  if [ -z "$tag" ]; then
    echo "Error: could not parse latest release version" >&2
    exit 1
  fi

  echo "$tag"
}

main
