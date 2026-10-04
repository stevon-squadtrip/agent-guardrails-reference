# Evidence before assertion

Guidance, not enforcement. Nothing checks that these rules were followed.

- **State a cause only after a tool result shows it.** "The swap failed because standby is unhealthy" needs
  a `health` output in this session that says so. Without one, say "probably" and name the check that would
  confirm it.
- **Re-read any value you quote.** If you cite a build number, a config value or an error rate, it should come
  from output you can point to, not from memory of an earlier step.
- **The system of record wins.** If `infractl status` disagrees with a file, a note or your own earlier
  summary, believe `infractl status`.
- **Say how sure you are, and why.** "High confidence: health output and logs agree" is useful.
  "I'm confident" on its own is not.
- **List the other explanations.** Before settling on a cause, name at least one alternative and the
  evidence that rules it out.
