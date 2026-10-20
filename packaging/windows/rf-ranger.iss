; RF Ranger installer (Inno Setup 6). Built by packaging/windows/build.sh:
;   ISCC /DVersion=0.1.8 /DSourceDir=<staged folder> /DIconFile=<ico> /DOutDir=<dir> rf-ranger.iss
;
; Installs for the current user by default (no administrator needed), into
; %LOCALAPPDATA%\Programs\RF Ranger. An administrator can choose "all users"
; instead, which also adds a Windows Firewall rule so receivers can be
; discovered and other screens (TVs, tablets) can connect.

#ifndef Version
  #error Pass /DVersion=x.y.z
#endif

[Setup]
; Keep AppId fixed forever: it is how upgrades find the existing install.
AppId={{6F0E7D6B-3B8A-4C55-9C51-2A1F0B7C9E14}
AppName=RF Ranger
AppVersion={#Version}
AppVerName=RF Ranger {#Version}
AppPublisher=RF Ranger
AppPublisherURL=https://github.com/jdnelson19/RF-Ranger
AppSupportURL=https://github.com/jdnelson19/RF-Ranger/issues
VersionInfoVersion={#Version}
DefaultDirName={autopf}\RF Ranger
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=RF-Ranger-{#Version}-Windows-Setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\rf-ranger.exe
UninstallDisplayName=RF Ranger
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; A running RF Ranger is stopped cleanly in PrepareToInstall; this is the fallback.
CloseApplications=yes
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; The web UI's file names change every version; don't leave old ones behind.
Type: filesandordirs; Name: "{app}\web"

[Files]
Source: "{#SourceDir}\rf-ranger.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\NOTICE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\RF Ranger"; Filename: "{app}\rf-ranger.exe"
Name: "{autodesktop}\RF Ranger"; Filename: "{app}\rf-ranger.exe"; Tasks: desktopicon

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""RF Ranger"" dir=in action=allow program=""{app}\rf-ranger.exe"" enable=yes profile=private,domain"; \
  Flags: runhidden; Check: IsAdminInstallMode; StatusMsg: "Allowing RF Ranger through Windows Firewall..."
Filename: "{app}\rf-ranger.exe"; Description: "{cm:LaunchProgram,RF Ranger}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\rf-ranger.exe"; Parameters: "--quit"; Flags: runhidden waituntilterminated; RunOnceId: "QuitRfRanger"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""RF Ranger"""; Flags: runhidden; Check: IsAdminInstallMode; RunOnceId: "RemoveFirewallRule"

[Code]
// Stop a running RF Ranger before replacing its files: it switches receiver
// metering off on the way out. Uses the new exe, extracted to a temp folder.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  ExtractTemporaryFile('rf-ranger.exe');
  Exec(ExpandConstant('{tmp}\rf-ranger.exe'), '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
