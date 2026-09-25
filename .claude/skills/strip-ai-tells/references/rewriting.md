# Dissolving banned words instead of substituting them

<!-- strip-ai-tells: ignore-start -->
The failure mode this file exists to prevent: the auditor flags "leverage", the word becomes "utilize", the check passes, and the sentence is exactly as bad.
<!-- strip-ai-tells: ignore-end --> The ban is on the move, not the token.

Each class below names why the word appears and what the sentence wanted to say instead.

The numbers and events in the After column are invented to show the shape of a specific. Never copy one into a real draft. A specific has to come from the profile, the repo, or the writer.

## Class 1: verbs that avoid naming the action

<!-- strip-ai-tells: ignore-start -->
`leverage`, `harness`, `utilize`, `employ`, `drive`, `foster`, `empower`, `enable`, `facilitate`
<!-- strip-ai-tells: ignore-end -->

These appear when the writer does not want to commit to what actually happened. The fix is to name the action.

<!-- strip-ai-tells: ignore-start -->
| Before | After |
| --- | --- |
| We leveraged the existing pipeline. | We reused the pipeline. / We read from the pipeline instead of rebuilding it. |
| The tool empowers engineers to ship faster. | Engineers ship without waiting on a review. |
| This fosters collaboration across teams. | The two teams now share one on-call rotation. |
| We harnessed GPU inference for the model. | We ran the model on the GPU. |
<!-- strip-ai-tells: ignore-end -->

Ask: who did what to what? Then write that.

## Class 2: adjectives that assert quality without evidence

<!-- strip-ai-tells: ignore-start -->
`robust`, `seamless`, `comprehensive`, `meticulous`, `intricate`, `nuanced`, `multifaceted`, `cutting-edge`
<!-- strip-ai-tells: ignore-end -->

These are the writer grading their own work. A reader discounts them automatically. Replace with the fact that would earn the adjective, or delete.

<!-- strip-ai-tells: ignore-start -->
| Before | After |
| --- | --- |
| A robust error-handling layer. | Every failure path returns a typed error; none swallow the exception. |
| Seamless integration with the API. | The integration needs no configuration file. |
| A comprehensive test suite. | 180 tests, including the two failure modes that caused the April outage. |
| Meticulous attention to detail. | (delete; show it instead) |
<!-- strip-ai-tells: ignore-end -->

If no fact is available, the adjective was decoration and the sentence is better without it.

## Class 3: inflated stakes

<!-- strip-ai-tells: ignore-start -->
`crucial`, `vital`, `pivotal`, `essential`, `critical`, `game-changing`, `revolutionary`, `transformative`
<!-- strip-ai-tells: ignore-end -->

These inflate importance the argument has not established. Either establish it or drop the word.

<!-- strip-ai-tells: ignore-start -->
| Before | After |
| --- | --- |
| This was a pivotal moment for the team. | After this, nobody shipped on Fridays again. |
| Testing is crucial. | Untested code reached production twice this quarter. |
| A game-changing improvement. | Build time went from 11 minutes to 40 seconds. |
<!-- strip-ai-tells: ignore-end -->

Note that the rewrite is usually shorter and always more interesting.

## Class 4: figurative nouns

`landscape`, `realm`, `tapestry`, `testament`, `journey`, `space` (as in "the AI space")

Dead metaphors that add length and no meaning. Almost always deletable.

<!-- strip-ai-tells: ignore-start -->
| Before | After |
| --- | --- |
| The landscape of developer tooling has shifted. | Developer tooling has shifted. |
| A testament to the team's work. | (delete; state what the team did) |
| Throughout my journey as an engineer. | (delete; start at the specific) |
| Companies in the AI space. | AI companies. |
<!-- strip-ai-tells: ignore-end -->

## Class 5: dead openers

<!-- strip-ai-tells: ignore-start -->
`In today's fast-paced world`, `In an era of`, `It's worth noting that`, `It's important to remember`, `Needless to say`, `At the end of the day`
<!-- strip-ai-tells: ignore-end -->

These occupy the position where the argument should start. Delete the phrase and begin at the next word; the sentence almost always survives intact.

<!-- strip-ai-tells: ignore-start -->
| Before | After |
| --- | --- |
| It's worth noting that the build is unsigned. | The build is unsigned. |
| In today's fast-paced world, teams need speed. | (delete entirely; say the specific thing about this team) |
| Needless to say, we reverted. | We reverted. |
<!-- strip-ai-tells: ignore-end -->

If the sentence does not survive deletion, it was carrying no content.

## Class 6: hiring cliches

<!-- strip-ai-tells: ignore-start -->
`hit the ground running`, `drive results`, `synergies`, `I am passionate about`, `I believe I would be a great fit`, `wear many hats`
<!-- strip-ai-tells: ignore-end -->

These signal that the writer is reaching for a register rather than saying anything. In a cover letter they actively cost credibility, because every applicant uses them.

<!-- strip-ai-tells: ignore-start -->
| Before | After |
| --- | --- |
| I am passionate about this domain. | (replace with the specific work done in it, and why it was worth doing) |
| I can hit the ground running. | I have shipped against this exact stack. |
| I believe I would be a great fit. | (delete; the letter is the argument) |
<!-- strip-ai-tells: ignore-end -->

## The substitution test

After rewriting, check the result against the original. If the only change is a token swap and the sentence carries the same non-information, the rewrite failed. A real fix changes what the sentence claims, usually by making it narrower and checkable.

## When a banned word is correct

Rarely, the flagged word is the precise one. `critical` in `critical path` or `critical section` is a term of art. `transform` in a data-transformation context is literal. `vital` about signs is literal.

Dismiss the hit and say why. Do not contort a technical term to satisfy a word list.
