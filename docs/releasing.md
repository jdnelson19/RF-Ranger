# Releasing RF Ranger

1. **Check:** run `npm test` and `npm run typecheck` in `server/`, and `npm run build` in `web/`.
2. **Bump** the version in both packages, without a tag:
   ```
   cd server && npm version 0.x.y --no-git-tag-version
   cd ../web && npm version 0.x.y --no-git-tag-version
   ```
   Commit as `Release 0.x.y`.
3. **Push `main`, then the tag:** `git tag v0.x.y && git push origin main v0.x.y`. The macOS workflow (signed and notarized `.dmg`), the Windows workflow (installer and portable `.zip`) and the Linux workflow (arm64 and x64 `.tar.gz`) each attach their files to the GitHub release.
4. **Check the release** has all five files: `RF-Ranger-0.x.y.dmg`, `RF-Ranger-0.x.y-Windows-Setup.exe`, `RF-Ranger-0.x.y-Windows-portable.zip`, `RF-Ranger-0.x.y-Linux-arm64.tar.gz` and `RF-Ranger-0.x.y-Linux-x64.tar.gz` (the Raspberry Pi installer downloads these; see [raspberry-pi.md](raspberry-pi.md)).
5. **Update the website's version note** ([rf-ranger-site](https://github.com/jdnelson19/rf-ranger-site)):
   - **Automatic:** the download buttons and the version under them follow the release, cached for up to 5 minutes.
   - **By hand:** make sure https://rfranger.app shows the new version. Once the site's **What's new** area exists (on its to-do list), add this release's highlights there.
   - **If the site doesn't update,** the site's Cloudflare build may not have run. Retry it from the Worker's Deployments page.
6. **Running apps:** v0.1.9 and later show "Update available" within about 6 hours of the release (or at their next start).
