[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("generate", "export-runtime")]
    [string]$Mode,

    [string]$RegistryPath,
    [string]$DigestOutputPath,
    [string]$VaultPath,
    [string]$CredentialId,
    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:InvocationParameters = @{} + $PSBoundParameters

try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
}
catch {
    [Console]::Error.WriteLine("[ERROR] Windows DPAPI support is unavailable")
    exit 1
}

$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:DpapiEntropy = $script:Utf8.GetBytes(
    "Bifang/OperationsAssistant/application-version-credentials/v1"
)
$script:AppIdPattern = '^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$'
$script:ChannelPattern = '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$'
$script:CredentialIdPattern = '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'
$script:AdvertisementContractTestCode = "bifang-screen-recorder-macos-arm64"
$script:SupportedPlatforms = @("windows", "macos", "linux")
$script:SupportedArchitectures = @("x64", "arm64", "ia32")
$script:RepositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot "..")
)

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "a file path must not be empty"
    }
    return [System.IO.Path]::GetFullPath($Path)
}

function Test-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )

    if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Array]) {
        return $false
    }
    $actualNames = @($Value.PSObject.Properties.Name | Sort-Object)
    $expectedNames = @($Expected | Sort-Object)
    return ($actualNames -join ",") -ceq ($expectedNames -join ",")
}

function Test-ExactStringArray {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string[]]$Expected
    )

    $actual = @($Value)
    if ($actual.Count -ne $Expected.Count) {
        return $false
    }
    for ($index = 0; $index -lt $Expected.Count; $index += 1) {
        if ($actual[$index] -isnot [string] -or $actual[$index] -cne $Expected[$index]) {
            return $false
        }
    }
    return $true
}

function ConvertFrom-JsonPreservingDateStrings {
    param([Parameter(Mandatory = $true)][string]$Json)

    $convertFromJson = Get-Command ConvertFrom-Json -CommandType Cmdlet -ErrorAction Stop
    if ($convertFromJson.Parameters.ContainsKey("DateKind")) {
        return $Json | ConvertFrom-Json -DateKind String
    }
    return $Json | ConvertFrom-Json
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($Bytes)
        return -join @($digest | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $sha256.Dispose()
    }
}

function New-StrongToken {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    }
    finally {
        $rng.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Test-StrongToken {
    param($Value)

    if ($Value -isnot [string] -or $Value -notmatch '^[A-Za-z0-9_-]{43,}$') {
        return $false
    }
    try {
        $normalized = $Value.Replace("-", "+").Replace("_", "/")
        $padding = (4 - ($normalized.Length % 4)) % 4
        $bytes = [Convert]::FromBase64String($normalized + ("=" * $padding))
        return $bytes.Length -ge 32
    }
    catch {
        return $false
    }
}

function Set-CurrentUserExclusiveAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$Directory
    )

    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $currentUser) {
        throw "the current Windows user identity is unavailable"
    }
    if ($Directory) {
        $security = New-Object System.Security.AccessControl.DirectorySecurity
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    else {
        $security = New-Object System.Security.AccessControl.FileSecurity
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $security.SetOwner($currentUser)
    $security.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $currentUser,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
    $aclExtensions = (
        [System.Management.Automation.PSTypeName]"System.IO.FileSystemAclExtensions"
    ).Type
    if ($null -ne $aclExtensions) {
        if ($Directory) {
            $item = New-Object System.IO.DirectoryInfo($Path)
            [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
        }
        else {
            $item = New-Object System.IO.FileInfo($Path)
            [System.IO.FileSystemAclExtensions]::SetAccessControl($item, $security)
        }
    }
    elseif ($Directory) {
        [System.IO.Directory]::SetAccessControl($Path, $security)
    }
    else {
        [System.IO.File]::SetAccessControl($Path, $security)
    }
}

function Initialize-PrivateDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([System.IO.File]::Exists($Path)) {
        throw "the private vault parent path is not a directory"
    }
    $created = -not [System.IO.Directory]::Exists($Path)
    [void][System.IO.Directory]::CreateDirectory($Path)
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "the private vault directory must not be a reparse point"
    }
    # Never rewrite ACLs on a caller-owned existing directory. The vault file is
    # always protected independently; a newly created dedicated directory gets
    # the same current-user-only ACL before any ciphertext is written.
    if ($created) {
        Set-CurrentUserExclusiveAcl -Path $Path -Directory $true
    }
}

function Write-AtomicNewBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes,
        [bool]$Private = $false
    )

    $fullPath = Get-FullPath $Path
    if ([System.IO.File]::Exists($fullPath) -or [System.IO.Directory]::Exists($fullPath)) {
        throw "refusing to overwrite an existing output file"
    }
    $parent = [System.IO.Path]::GetDirectoryName($fullPath)
    if ([string]::IsNullOrWhiteSpace($parent)) {
        throw "the output file must have a parent directory"
    }
    [void][System.IO.Directory]::CreateDirectory($parent)
    $temporaryPath = Join-Path $parent (
        ".{0}.{1}.tmp" -f [System.IO.Path]::GetFileName($fullPath), [Guid]::NewGuid().ToString("N")
    )
    $stream = $null
    try {
        $stream = New-Object System.IO.FileStream(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if ($Private) {
            Set-CurrentUserExclusiveAcl -Path $temporaryPath -Directory $false
        }
        [System.IO.File]::Move($temporaryPath, $fullPath)
    }
    catch {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ([System.IO.File]::Exists($temporaryPath)) {
            [System.IO.File]::Delete($temporaryPath)
        }
        throw
    }
    return $fullPath
}

function Read-Registry {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = Get-FullPath $Path
    $file = Get-Item -LiteralPath $fullPath -Force
    if ($file.PSIsContainer -or $file.Length -gt 1048576) {
        throw "the application registry is missing or too large"
    }
    try {
        $registry = $script:Utf8.GetString([System.IO.File]::ReadAllBytes($fullPath)) |
            ConvertFrom-Json
    }
    catch {
        throw "the application registry is not valid UTF-8 JSON"
    }
    if (-not (Test-ExactProperties $registry @("apps", "schema_version")) -or
        $registry.schema_version -ne 3) {
        throw "the application registry must use the exact schema version 3 shape"
    }
    $apps = @($registry.apps)
    if ($apps.Count -lt 1 -or $apps.Count -gt 100) {
        throw "the application registry must contain from 1 to 100 applications"
    }

    $seenApps = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $seenCodes = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $seenStreams = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $normalizedApps = New-Object 'System.Collections.Generic.List[object]'
    foreach ($app in $apps) {
        if (-not (Test-ExactProperties $app @("app_id", "release_streams")) -or
            $app.app_id -isnot [string] -or
            $app.app_id -notmatch $script:AppIdPattern -or
            -not $seenApps.Add($app.app_id)) {
            throw "the application registry contains an invalid or duplicate app_id"
        }
        $streams = @($app.release_streams)
        if ($streams.Count -lt 1 -or $streams.Count -gt 12) {
            throw "each application must contain from 1 to 12 release streams"
        }
        $normalizedStreams = New-Object 'System.Collections.Generic.List[object]'
        foreach ($stream in $streams) {
            if (-not (Test-ExactProperties $stream @("architecture", "channel", "code", "platform")) -or
                $stream.code -isnot [string] -or
                $stream.code -notmatch $script:AppIdPattern -or
                $stream.platform -isnot [string] -or
                $script:SupportedPlatforms -cnotcontains $stream.platform -or
                $stream.architecture -isnot [string] -or
                $script:SupportedArchitectures -cnotcontains $stream.architecture -or
                $stream.channel -isnot [string] -or
                $stream.channel -notmatch $script:ChannelPattern -or
                -not $seenCodes.Add($stream.code)) {
                throw "the application registry contains an invalid or duplicate release stream"
            }
            $streamIdentity = "{0}`0{1}`0{2}`0{3}" -f
                $app.app_id, $stream.platform, $stream.architecture, $stream.channel
            if (-not $seenStreams.Add($streamIdentity)) {
                throw "the application registry contains a duplicate release identity"
            }
            [void]$normalizedStreams.Add([pscustomobject]@{
                code = $stream.code
                platform = $stream.platform
                architecture = $stream.architecture
                channel = $stream.channel
            })
        }
        [void]$normalizedApps.Add([pscustomobject]@{
            app_id = $app.app_id
            release_streams = $normalizedStreams.ToArray()
        })
    }
    return $normalizedApps.ToArray()
}

function ConvertTo-DigestCredential {
    param([Parameter(Mandatory = $true)]$RawCredential)

    return [pscustomobject]@{
        credential_id = $RawCredential.credential_id
        key_sha256 = Get-Sha256Hex $script:Utf8.GetBytes($RawCredential.app_key)
        secret_sha256 = @(
            Get-Sha256Hex $script:Utf8.GetBytes($RawCredential.app_secret)
        )
        app_id = $RawCredential.app_id
        codes = @($RawCredential.codes)
        scopes = @($RawCredential.scopes)
    }
}

function Protect-VaultJson {
    param([Parameter(Mandatory = $true)][string]$Json)

    $plaintext = $script:Utf8.GetBytes($Json)
    try {
        $ciphertext = [System.Security.Cryptography.ProtectedData]::Protect(
            $plaintext,
            $script:DpapiEntropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Convert]::ToBase64String($ciphertext)
    }
    catch {
        throw "Windows CurrentUser DPAPI could not protect the credential vault"
    }
    finally {
        [Array]::Clear($plaintext, 0, $plaintext.Length)
    }
}

function Unprotect-VaultJson {
    param([Parameter(Mandatory = $true)][string]$CiphertextBase64)

    try {
        $ciphertext = [Convert]::FromBase64String($CiphertextBase64)
        if ([Convert]::ToBase64String($ciphertext) -cne $CiphertextBase64) {
            throw "non-canonical ciphertext"
        }
        $plaintext = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $ciphertext,
            $script:DpapiEntropy,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        try {
            return $script:Utf8.GetString($plaintext)
        }
        finally {
            [Array]::Clear($plaintext, 0, $plaintext.Length)
        }
    }
    catch {
        throw "the credential vault cannot be decrypted by the current Windows user"
    }
}

function Read-RawVault {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = Get-FullPath $Path
    $file = Get-Item -LiteralPath $fullPath -Force
    if ($file.PSIsContainer -or
        ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $file.Length -gt 4194304) {
        throw "the credential vault is missing or invalid"
    }
    try {
        $envelope = $script:Utf8.GetString([System.IO.File]::ReadAllBytes($fullPath)) |
            ConvertFrom-Json
    }
    catch {
        throw "the credential vault envelope is not valid UTF-8 JSON"
    }
    if (-not (Test-ExactProperties $envelope @("ciphertext_base64", "protection", "schema_version")) -or
        $envelope.schema_version -ne 1 -or
        $envelope.protection -cne "Windows-DPAPI-CurrentUser" -or
        $envelope.ciphertext_base64 -isnot [string]) {
        throw "the credential vault envelope has an invalid shape"
    }

    $vaultJson = Unprotect-VaultJson $envelope.ciphertext_base64
    try {
        $vault = ConvertFrom-JsonPreservingDateStrings $vaultJson
    }
    catch {
        throw "the decrypted credential vault is invalid"
    }
    if (-not (Test-ExactProperties $vault @("created_at", "credentials", "schema_version")) -or
        $vault.schema_version -ne 1 -or
        $vault.created_at -isnot [string]) {
        throw "the decrypted credential vault has an invalid shape"
    }

    $credentials = @($vault.credentials)
    if ($credentials.Count -lt 1 -or $credentials.Count -gt 300) {
        throw "the decrypted credential vault has an invalid credential count"
    }
    $seenIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $seenKeys = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($credential in $credentials) {
        if (-not (Test-ExactProperties $credential @(
                    "app_id", "app_key", "app_secret", "codes", "credential_id", "role", "scopes"
                )) -or
            $credential.credential_id -isnot [string] -or
            $credential.credential_id -notmatch $script:CredentialIdPattern -or
            -not $seenIds.Add($credential.credential_id) -or
            $credential.app_id -isnot [string] -or
            $credential.app_id -notmatch $script:AppIdPattern -or
            -not (Test-StrongToken $credential.app_key) -or
            -not (Test-StrongToken $credential.app_secret) -or
            -not $seenKeys.Add($credential.app_key)) {
            throw "the decrypted credential vault contains an invalid credential"
        }
        $codes = @($credential.codes)
        if ($codes.Count -lt 1 -or
            @($codes | Where-Object { $_ -isnot [string] -or $_ -notmatch $script:AppIdPattern }).Count -gt 0 -or
            @($codes | Select-Object -Unique).Count -ne $codes.Count) {
            throw "the decrypted credential vault contains an invalid code binding"
        }
        $validRole = switch ($credential.role) {
            "runtime" {
                $codes.Count -eq 1 -and (
                    Test-ExactStringArray $credential.scopes @("versions:check")
                )
            }
            "contract-test" {
                $codes.Count -eq 1 -and
                $credential.credential_id -ceq ("contract-ads-{0}" -f $codes[0]) -and
                $codes[0] -ceq $script:AdvertisementContractTestCode -and
                (Test-ExactStringArray $credential.scopes @("versions:check", "ads:show"))
            }
            "management-read" {
                Test-ExactStringArray $credential.scopes @("versions:read", "ads:read")
            }
            "management-write" {
                Test-ExactStringArray $credential.scopes @("versions:write", "ads:write")
            }
            default { $false }
        }
        if (-not $validRole) {
            throw "the decrypted credential vault contains an invalid role binding"
        }
    }
    return $credentials
}

function Resolve-GitExecutable {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    foreach ($base in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not [string]::IsNullOrWhiteSpace($base)) {
            [void]$candidates.Add((Join-Path $base "Git\cmd\git.exe"))
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe"))
    }
    try {
        $command = Get-Command git.exe -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
        if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) {
            [void]$candidates.Add($command.Source)
        }
    }
    catch {
        # Fixed installation locations above remain authoritative candidates.
    }

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in $candidates) {
        $fullPath = [System.IO.Path]::GetFullPath($candidate)
        if (-not $seen.Add($fullPath) -or -not [System.IO.File]::Exists($fullPath)) {
            continue
        }
        $item = Get-Item -LiteralPath $fullPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
            return $fullPath
        }
    }
    throw "an absolute non-reparse git.exe is required to verify a worktree export path"
}

function Find-ContainingGitMarker {
    param([Parameter(Mandatory = $true)][string]$TargetPath)

    $cursor = [System.IO.Path]::GetDirectoryName((Get-FullPath $TargetPath))
    while (-not [System.IO.Directory]::Exists($cursor)) {
        $parent = [System.IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $cursor) {
            return $null
        }
        $cursor = $parent
    }
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        $marker = Join-Path $cursor ".git"
        if ([System.IO.File]::Exists($marker) -or [System.IO.Directory]::Exists($marker)) {
            return $cursor
        }
        $parent = [System.IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $cursor) {
            break
        }
        $cursor = $parent
    }
    return $null
}

function ConvertTo-NativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.IndexOf([char]0) -ge 0) {
        throw "a native command argument contains an invalid character"
    }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes += 1
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * ($backslashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-GitQuiet {
    param(
        [Parameter(Mandatory = $true)][string]$GitPath,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $GitPath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.Arguments = (@($Arguments | ForEach-Object {
        ConvertTo-NativeArgument ([string]$_)
    }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "git.exe could not be started"
        }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) {
            try {
                $process.Kill()
            }
            catch {
                # The fixed failure below remains authoritative.
            }
            throw "git.exe path verification timed out"
        }
        $stdoutText = $stdout.GetAwaiter().GetResult()
        [void]$stderr.GetAwaiter().GetResult()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            Stdout = $stdoutText
        }
    }
    finally {
        $process.Dispose()
    }
}

function Assert-SafeRuntimeExportPath {
    param([Parameter(Mandatory = $true)][string]$TargetPath)

    $fullTargetPath = Get-FullPath $TargetPath
    $gitMarkerRoot = Find-ContainingGitMarker $fullTargetPath
    if ($null -eq $gitMarkerRoot) {
        return
    }
    $gitPath = Resolve-GitExecutable
    $rootResult = Invoke-GitQuiet -GitPath $gitPath -WorkingDirectory $gitMarkerRoot `
        -Arguments @("rev-parse", "--show-toplevel")
    $rootOutput = @($rootResult.Stdout.Trim() -split "`r?`n")
    if ($rootResult.ExitCode -ne 0 -or $rootOutput.Count -ne 1 -or
        [string]::IsNullOrWhiteSpace($rootOutput[0])) {
        throw "the containing Git worktree could not be verified"
    }
    $worktreeRoot = Get-FullPath ([string]$rootOutput[0])
    $worktreePrefix = $worktreeRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullTargetPath.StartsWith(
            $worktreePrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "the runtime export path is outside the verified Git worktree"
    }
    $relativePath = $fullTargetPath.Substring($worktreePrefix.Length).Replace("\", "/")
    $trackedResult = Invoke-GitQuiet -GitPath $gitPath -WorkingDirectory $worktreeRoot `
        -Arguments @("ls-files", "--error-unmatch", "--", $relativePath)
    $trackedExitCode = $trackedResult.ExitCode
    if ($trackedExitCode -eq 0) {
        throw "the runtime credential export path is tracked by Git"
    }
    if ($trackedExitCode -ne 1) {
        throw "the runtime credential export path could not be checked against tracked files"
    }
    $ignoredResult = Invoke-GitQuiet -GitPath $gitPath -WorkingDirectory $worktreeRoot `
        -Arguments @("check-ignore", "--quiet", "--", $relativePath)
    $ignoredExitCode = $ignoredResult.ExitCode
    if ($ignoredExitCode -eq 0) {
        return
    }
    if ($ignoredExitCode -eq 1) {
        throw "a runtime credential export inside a Git worktree must be ignored"
    }
    throw "the runtime credential export ignore rule could not be verified"
}

function Invoke-Generate {
    if ($script:InvocationParameters.ContainsKey("CredentialId") -or
        $script:InvocationParameters.ContainsKey("OutputPath")) {
        throw "generate does not accept CredentialId or OutputPath"
    }
    $resolvedRegistryPath = if ($RegistryPath) {
        Get-FullPath $RegistryPath
    }
    else {
        Join-Path $script:RepositoryRoot "cloudbase\apps.json"
    }
    $resolvedDigestPath = if ($DigestOutputPath) {
        Get-FullPath $DigestOutputPath
    }
    else {
        Join-Path $script:RepositoryRoot "cloudbase\application-version-credentials.b64"
    }
    if (-not $VaultPath) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw "LOCALAPPDATA is required for the default private vault"
        }
        $resolvedVaultPath = Join-Path $env:LOCALAPPDATA "Bifang\OperationsAssistant\application-version-credentials.dpapi.json"
    }
    else {
        $resolvedVaultPath = Get-FullPath $VaultPath
    }
    if ([System.IO.File]::Exists($resolvedDigestPath) -or
        [System.IO.Directory]::Exists($resolvedDigestPath) -or
        [System.IO.File]::Exists($resolvedVaultPath) -or
        [System.IO.Directory]::Exists($resolvedVaultPath)) {
        throw "refusing to overwrite an existing credential output"
    }

    $apps = Read-Registry $resolvedRegistryPath
    $contractTestStreamCount = @(
        $apps | ForEach-Object { $_.release_streams } | Where-Object {
            $_.code -ceq $script:AdvertisementContractTestCode
        }
    ).Count
    if ($contractTestStreamCount -ne 1) {
        throw "the registry must contain the reviewed advertisement contract-test stream"
    }
    $rawCredentials = New-Object 'System.Collections.Generic.List[object]'
    foreach ($app in $apps) {
        $appCodes = @($app.release_streams | ForEach-Object { $_.code })
        foreach ($stream in $app.release_streams) {
            $isAdvertisementContractTest =
                $stream.code -ceq $script:AdvertisementContractTestCode
            $credentialScopes = if ($isAdvertisementContractTest) {
                @("versions:check", "ads:show")
            }
            else {
                @("versions:check")
            }
            [void]$rawCredentials.Add([pscustomobject]@{
                credential_id = if ($isAdvertisementContractTest) {
                    "contract-ads-{0}" -f $stream.code
                }
                else {
                    "runtime-{0}" -f $stream.code
                }
                role = if ($isAdvertisementContractTest) { "contract-test" } else { "runtime" }
                app_id = $app.app_id
                codes = @($stream.code)
                scopes = @($credentialScopes)
                app_key = New-StrongToken
                app_secret = New-StrongToken
            })
        }
        [void]$rawCredentials.Add([pscustomobject]@{
            credential_id = "mgmt-read-{0}" -f $app.app_id
            role = "management-read"
            app_id = $app.app_id
            codes = @($appCodes)
            scopes = @("versions:read", "ads:read")
            app_key = New-StrongToken
            app_secret = New-StrongToken
        })
        [void]$rawCredentials.Add([pscustomobject]@{
            credential_id = "mgmt-write-{0}" -f $app.app_id
            role = "management-write"
            app_id = $app.app_id
            codes = @($appCodes)
            scopes = @("versions:write", "ads:write")
            app_key = New-StrongToken
            app_secret = New-StrongToken
        })
    }

    $digestCredentials = @(
        $rawCredentials | ForEach-Object { ConvertTo-DigestCredential $_ }
    )
    $digestConfiguration = [pscustomobject]@{
        schema_version = 1
        credentials = $digestCredentials
    }
    $digestJson = $digestConfiguration | ConvertTo-Json -Compress -Depth 10
    $digestBase64 = [Convert]::ToBase64String($script:Utf8.GetBytes($digestJson))
    $configurationSha256 = Get-Sha256Hex $script:Utf8.GetBytes($digestBase64)

    $rawVault = [pscustomobject]@{
        schema_version = 1
        created_at = [DateTime]::UtcNow.ToString("o")
        credentials = $rawCredentials.ToArray()
    }
    $rawVaultJson = $rawVault | ConvertTo-Json -Compress -Depth 10
    $envelope = [pscustomobject]@{
        schema_version = 1
        protection = "Windows-DPAPI-CurrentUser"
        ciphertext_base64 = Protect-VaultJson $rawVaultJson
    }
    $envelopeBytes = $script:Utf8.GetBytes(
        ($envelope | ConvertTo-Json -Compress -Depth 4)
    )
    $digestBytes = $script:Utf8.GetBytes($digestBase64)
    $vaultParent = [System.IO.Path]::GetDirectoryName($resolvedVaultPath)
    Initialize-PrivateDirectory $vaultParent

    $vaultWritten = $false
    try {
        $resolvedVaultPath = Write-AtomicNewBytes -Path $resolvedVaultPath -Bytes $envelopeBytes -Private $true
        $vaultWritten = $true
        $resolvedDigestPath = Write-AtomicNewBytes -Path $resolvedDigestPath -Bytes $digestBytes
    }
    catch {
        if ($vaultWritten -and [System.IO.File]::Exists($resolvedVaultPath)) {
            [System.IO.File]::Delete($resolvedVaultPath)
        }
        throw
    }

    $safeCredentials = @(
        $rawCredentials | ForEach-Object {
            [pscustomobject]@{
                credential_id = $_.credential_id
                role = $_.role
                app_id = $_.app_id
                codes = @($_.codes)
                scopes = @($_.scopes)
            }
        }
    )
    return [pscustomobject]@{
        status = "generated"
        registry_path = $resolvedRegistryPath
        digest_configuration_path = $resolvedDigestPath
        vault_path = $resolvedVaultPath
        configuration_sha256 = $configurationSha256
        credentials = $safeCredentials
    }
}

function Invoke-ExportRuntime {
    if ($script:InvocationParameters.ContainsKey("RegistryPath") -or
        $script:InvocationParameters.ContainsKey("DigestOutputPath")) {
        throw "export-runtime does not accept RegistryPath or DigestOutputPath"
    }
    if ([string]::IsNullOrWhiteSpace($CredentialId) -or
        $CredentialId -notmatch $script:CredentialIdPattern -or
        [string]::IsNullOrWhiteSpace($OutputPath)) {
        throw "export-runtime requires a valid CredentialId and OutputPath"
    }
    if (-not $VaultPath) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw "LOCALAPPDATA is required for the default private vault"
        }
        $resolvedVaultPath = Join-Path $env:LOCALAPPDATA "Bifang\OperationsAssistant\application-version-credentials.dpapi.json"
    }
    else {
        $resolvedVaultPath = Get-FullPath $VaultPath
    }
    $resolvedOutputPath = Get-FullPath $OutputPath
    if ([System.IO.File]::Exists($resolvedOutputPath) -or
        [System.IO.Directory]::Exists($resolvedOutputPath)) {
        throw "refusing to overwrite an existing runtime credential export"
    }
    Assert-SafeRuntimeExportPath $resolvedOutputPath

    $credentials = Read-RawVault $resolvedVaultPath
    $matches = @($credentials | Where-Object { $_.credential_id -ceq $CredentialId })
    if ($matches.Count -ne 1) {
        throw "the requested credential_id does not identify one credential"
    }
    $credential = $matches[0]
    if ($credential.role -cne "runtime") {
        throw "only client runtime credentials can be exported"
    }
    $runtimeExport = [pscustomobject]@{
        schema_version = 1
        credential_id = $credential.credential_id
        app_id = $credential.app_id
        code = @($credential.codes)[0]
        scopes = @($credential.scopes)
        app_key = $credential.app_key
        app_secret = $credential.app_secret
    }
    $runtimeBytes = $script:Utf8.GetBytes(
        ($runtimeExport | ConvertTo-Json -Compress -Depth 5)
    )
    $resolvedOutputPath = Write-AtomicNewBytes -Path $resolvedOutputPath -Bytes $runtimeBytes -Private $true
    return [pscustomobject]@{
        status = "runtime-exported"
        credential_id = $credential.credential_id
        app_id = $credential.app_id
        code = @($credential.codes)[0]
        scopes = @($credential.scopes)
        output_path = $resolvedOutputPath
    }
}

try {
    $result = if ($Mode -ceq "generate") {
        Invoke-Generate
    }
    else {
        Invoke-ExportRuntime
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 10))
}
catch {
    [Console]::Error.WriteLine("[ERROR] {0}" -f $_.Exception.Message)
    exit 1
}
