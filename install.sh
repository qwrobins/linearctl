#!/bin/sh
set -e

REPO="qwrobins/linearctl"
INSTALL_DIR="${LINEAR_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="linearctl"

# Keep paths separately and quoted: INSTALL_DIR and TMPDIR may contain spaces.
# Cleanup runs on success, error, and catchable interruptions.
STAGED_BINARY=""
DEB_FILE=""
CHECKSUMS_FILE=""

cleanup() {
  for f in "$STAGED_BINARY" "$DEB_FILE" "$CHECKSUMS_FILE"; do
    if [ -n "$f" ]; then
      rm -f "$f"
    fi
  done
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

main() {
  os=$(detect_os)
  arch=$(detect_arch)
  artifact="linearctl-${os}-${arch}"

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
  checksums_url="${base_url}/checksums.txt"

  # On Linux with dpkg, use .deb package
  if [ "$os" = "linux" ] && command -v dpkg > /dev/null 2>&1 && [ "$LINEAR_NO_DEB" != "1" ]; then
    deb_arch=$(detect_deb_arch)
    deb_name="linearctl_${version#v}_${deb_arch}.deb"
    deb_url="${base_url}/${deb_name}"
    DEB_FILE=$(mktemp "${TMPDIR:-/tmp}/linearctl.XXXXXX.deb")

    echo "Installing linearctl ${version} via deb package (${deb_arch})..."
    download "$deb_url" "$DEB_FILE"
    download_checksums "$checksums_url"
    verify_checksum "$DEB_FILE" "$deb_name" "$CHECKSUMS_FILE"
    sudo dpkg -i "$DEB_FILE"
    echo "Installed ${BINARY_NAME} to /usr/bin/${BINARY_NAME}"
    echo ""
    echo "Update agent skills to match this version:"
    echo "  ${BINARY_NAME} skills install"
    return
  fi

  url="${base_url}/${artifact}"

  echo "Installing linearctl ${version} (${os}/${arch})..."
  echo "  From: ${url}"
  echo "  To:   ${INSTALL_DIR}/${BINARY_NAME}"

  mkdir -p "$INSTALL_DIR"

  # Stage on the destination filesystem so the final rename is atomic. Never
  # touch the installed binary until the replacement is verified and ready.
  STAGED_BINARY=$(mktemp "${INSTALL_DIR}/.${BINARY_NAME}.XXXXXX")
  download "$url" "$STAGED_BINARY"

  # Verify checksum (mandatory — an unverified binary is never installed)
  download_checksums "$checksums_url"
  verify_checksum "$STAGED_BINARY" "$artifact" "$CHECKSUMS_FILE"

  chmod 755 "$STAGED_BINARY"

  # Remove macOS quarantine attribute so Gatekeeper doesn't block unsigned binary
  if [ "$os" = "darwin" ] && command -v xattr > /dev/null 2>&1; then
    xattr -d com.apple.quarantine "$STAGED_BINARY" 2>/dev/null || true
  fi

  mv -f "$STAGED_BINARY" "${INSTALL_DIR}/${BINARY_NAME}"

  echo "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

  if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
    echo ""
    echo "Add ${INSTALL_DIR} to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi

  echo ""
  echo "Update agent skills to match this version:"
  echo "  ${BINARY_NAME} skills install"
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

# Downloads checksums.txt into CHECKSUMS_FILE. Fails closed: if the checksums
# cannot be retrieved, the install aborts rather than skipping verification.
download_checksums() {
  CHECKSUMS_FILE=$(mktemp)
  if ! download "$1" "$CHECKSUMS_FILE" 2>/dev/null; then
    echo "Error: could not download checksums.txt — refusing to install unverified artifacts" >&2
    exit 1
  fi
}

verify_checksum() {
  binary_path="$1"
  artifact_name="$2"
  checksums_file="$3"

  expected=$(awk -v name="$artifact_name" '$2 == name {print $1}' "$checksums_file")
  if [ -z "$expected" ]; then
    echo "Error: no checksum found for ${artifact_name} in checksums.txt — refusing to install" >&2
    exit 1
  fi

  if command -v sha256sum > /dev/null 2>&1; then
    actual=$(sha256sum "$binary_path" | awk '{print $1}')
  elif command -v shasum > /dev/null 2>&1; then
    actual=$(shasum -a 256 "$binary_path" | awk '{print $1}')
  else
    echo "Error: sha256sum or shasum is required to verify the download — refusing to install" >&2
    exit 1
  fi

  if [ "$actual" != "$expected" ]; then
    echo "Error: checksum mismatch" >&2
    echo "  Expected: ${expected}" >&2
    echo "  Actual:   ${actual}" >&2
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

detect_deb_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      echo "Error: unsupported architecture for deb: $(uname -m)" >&2
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

# Note: runs in a command-substitution subshell, so it removes its own temp
# files explicitly (the EXIT trap cannot see files tracked inside a subshell).
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
