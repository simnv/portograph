# Turn-order fixtures

Test-only sheets of the turn round (`docs/design/turn-order.md`). They stay out of `goldens/` because the corpus gate would read a gate finding there as a NEW-FAIL.

| Sheet | Rule |
|---|---|
| [a-face-with-a-held-straight-link-keeps-far-end-order.yaml](a-face-with-a-held-straight-link-keeps-far-end-order.yaml) | Dense-16x9 ticket 05: the offer leaves out a face that holds a held straight link, the trial reserves it for far-end order (`turnExcept`), the trial that turns the other face is kept. Without the reservation the trial turns both and is refused. Test `test/pipeline/turn-order.test.ts`. |
