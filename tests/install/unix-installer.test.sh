#!/bin/sh
# Isolated installer integration tests: all downloads are local mock responses.
set -eu

INSTALLER=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)/install.sh
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT
trap 'exit 1' HUP INT TERM

mkdir -p "$TEST_ROOT/mock-bin" "$TEST_ROOT/fixtures"
printf 'WORKING_EXISTING_BINARY\n' > "$TEST_ROOT/fixtures/existing"
printf '#!/bin/sh\nprintf "VERIFIED_REPLACEMENT\\n"\n' > "$TEST_ROOT/fixtures/replacement"
if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM=$(sha256sum "$TEST_ROOT/fixtures/replacement" | awk '{print $1}')
else
  CHECKSUM=$(shasum -a 256 "$TEST_ROOT/fixtures/replacement" | awk '{print $1}')
fi
export TEST_ROOT CHECKSUM

# Pin platform detection so these tests exercise the raw Unix path everywhere.
cat > "$TEST_ROOT/mock-bin/uname" <<'MOCK'
#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
  *) exit 1 ;;
esac
MOCK

cat > "$TEST_ROOT/mock-bin/curl" <<'MOCK'
#!/bin/sh
set -eu
[ "$#" -eq 4 ] && [ "$1" = '-fsSL' ] && [ "$3" = '-o' ] || exit 90
url=$2
output=$4

# The old installation must remain untouched throughout both downloads.
if [ "$INSTALL_STATE" = upgrade ]; then
  cmp -s "$LINEAR_INSTALL_DIR/linearctl" "$TEST_ROOT/fixtures/existing" || exit 91
else
  [ ! -e "$LINEAR_INSTALL_DIR/linearctl" ] || exit 92
fi

case "$url" in
  https://github.com/qwrobins/linearctl/releases/download/v9.9.9/linearctl-linux-x64)
    # The binary must be staged beside (not at) the installed executable.
    [ "$(dirname "$output")" = "$LINEAR_INSTALL_DIR" ] || exit 93
    [ "$output" != "$LINEAR_INSTALL_DIR/linearctl" ] || exit 94
    printf 'PARTIAL_DOWNLOAD\n' > "$output"
    case "$SCENARIO" in
      binary-failure) exit 22 ;;
      binary-interrupt) kill -s "$TEST_SIGNAL" "$PPID"; exit 0 ;;
    esac
    cp "$TEST_ROOT/fixtures/replacement" "$output"
    ;;
  https://github.com/qwrobins/linearctl/releases/download/v9.9.9/checksums.txt)
    printf '%s  unrelated-artifact\n' "$CHECKSUM" > "$output"
    case "$SCENARIO" in
      checksums-failure) exit 22 ;;
      checksums-interrupt) kill -s "$TEST_SIGNAL" "$PPID"; exit 0 ;;
      missing-checksum) exit 0 ;;
      mismatched-checksum)
        printf '%064d  linearctl-linux-x64\n' 0 > "$output"
        exit 0
        ;;
    esac
    printf '%s  linearctl-linux-x64\n' "$CHECKSUM" >> "$output"
    ;;
  *) echo "Unexpected URL: $url" >&2; exit 95 ;;
esac
MOCK
chmod +x "$TEST_ROOT/mock-bin/"*

fail() {
  echo "FAIL: $INSTALL_STATE / $SCENARIO / $TEST_SIGNAL: $*" >&2
  if [ -f "$CASE_ROOT/output" ]; then
    cat "$CASE_ROOT/output" >&2
  fi
  exit 1
}

run_case() {
  INSTALL_STATE=$1
  SCENARIO=$2
  TEST_SIGNAL=${3:-TERM}
  # Include spaces and glob characters in both temp and destination paths.
  CASE_ROOT="$TEST_ROOT/$INSTALL_STATE-$SCENARIO-$TEST_SIGNAL [case]"
  LINEAR_INSTALL_DIR="$CASE_ROOT/install dir [bin]"
  TMPDIR="$CASE_ROOT/temp files [tmp]"
  export INSTALL_STATE SCENARIO TEST_SIGNAL LINEAR_INSTALL_DIR TMPDIR
  mkdir -p "$LINEAR_INSTALL_DIR" "$TMPDIR"
  if [ "$INSTALL_STATE" = upgrade ]; then
    cp "$TEST_ROOT/fixtures/existing" "$LINEAR_INSTALL_DIR/linearctl"
    chmod 751 "$LINEAR_INSTALL_DIR/linearctl"
    # A hard link catches in-place overwrites, even on a successful upgrade.
    ln "$LINEAR_INSTALL_DIR/linearctl" "$CASE_ROOT/original-inode"
    original_mode=$(LC_ALL=C ls -ld "$LINEAR_INSTALL_DIR/linearctl" | awk '{print $1}')
  fi

  status=0
  PATH="$TEST_ROOT/mock-bin:$PATH" LINEAR_NO_DEB=1 LINEAR_VERSION=v9.9.9 \
    sh "$INSTALLER" > "$CASE_ROOT/output" 2>&1 || status=$?

  if [ "$SCENARIO" = success ]; then
    [ "$status" -eq 0 ] || fail "installer exited $status"
    cmp -s "$LINEAR_INSTALL_DIR/linearctl" "$TEST_ROOT/fixtures/replacement" || fail 'replacement content differs'
    mode=$(LC_ALL=C ls -ld "$LINEAR_INSTALL_DIR/linearctl" | awk '{print $1}')
    [ "$mode" = '-rwxr-xr-x' ] || fail "unexpected replacement permissions: $mode"
    [ "$("$LINEAR_INSTALL_DIR/linearctl")" = VERIFIED_REPLACEMENT ] || fail 'replacement cannot execute'
    grep -q 'Checksum verified' "$CASE_ROOT/output" || fail 'checksum was not verified'
  else
    [ "$status" -ne 0 ] || fail 'installer unexpectedly succeeded'
    if [ "$INSTALL_STATE" = upgrade ]; then
      cmp -s "$LINEAR_INSTALL_DIR/linearctl" "$TEST_ROOT/fixtures/existing" || fail 'existing binary changed or was removed'
      mode=$(LC_ALL=C ls -ld "$LINEAR_INSTALL_DIR/linearctl" | awk '{print $1}')
      [ "$mode" = "$original_mode" ] || fail 'existing permissions changed'
    else
      [ ! -e "$LINEAR_INSTALL_DIR/linearctl" ] || fail 'failed install left a binary'
    fi
    # Ensure the intended failure path, not a mock assertion, caused the exit.
    case "$SCENARIO" in
      binary-failure) [ "$status" -eq 22 ] || fail 'wrong download failure' ;;
      checksums-failure) grep -q 'could not download checksums.txt' "$CASE_ROOT/output" || fail 'wrong checksum retrieval failure' ;;
      missing-checksum) grep -q 'no checksum found' "$CASE_ROOT/output" || fail 'wrong missing checksum failure' ;;
      mismatched-checksum) grep -q 'checksum mismatch' "$CASE_ROOT/output" || fail 'wrong checksum mismatch failure' ;;
      *-interrupt) [ "$status" -eq 1 ] || fail 'signal trap did not run' ;;
    esac
  fi

  if [ "$INSTALL_STATE" = upgrade ]; then
    cmp -s "$CASE_ROOT/original-inode" "$TEST_ROOT/fixtures/existing" || fail 'original inode was overwritten'
  fi
  [ -z "$(find "$LINEAR_INSTALL_DIR" -mindepth 1 ! -name linearctl -print)" ] || fail 'staging files leaked'
  [ -z "$(find "$TMPDIR" -mindepth 1 -print)" ] || fail 'checksum temp files leaked'
  echo "PASS: $INSTALL_STATE / $SCENARIO / $TEST_SIGNAL"
}

for state in upgrade fresh; do
  for scenario in binary-failure checksums-failure missing-checksum mismatched-checksum success; do
    run_case "$state" "$scenario"
  done
  for signal in HUP INT TERM; do
    run_case "$state" binary-interrupt "$signal"
    run_case "$state" checksums-interrupt "$signal"
  done
done
