# ADR 0055 — Sample DXF: a generated original drawing instead of a downloaded one

- Status: accepted
- Date: 2026-11-03
- Requirements: FR-SITE-2, NFR-MAINT-1
- Deviation: `docs/SPEC.md` §4.5 (line 206) asks for a free-licence warehouse DXF downloaded from the internet, with
  its source and licence recorded, and a generated fallback.
- Implemented in: `agent/tools/make_sample_dxf.py`, `agent/tools/sample/warehouse.dxf`,
  `agent/tools/sample/README.md`, `agent/tests/test_make_sample_dxf.py`, `agent/pyproject.toml`, `agent/uv.lock`,
  `Makefile`, `.gitignore`, `apps/console/test/site/dxf/sample-dxf.test.ts`

## Context

SPEC §4.5 expects a sample drawing with a clear licence, found on the internet. No such drawing was checked for M7, and
the milestone is due on 5 to 6 November. A downloaded drawing would also need a licence review, a recorded source and a
check that it has no third-party text, fonts or blocks. The generated drawing has none of these questions: the author
wrote the script, and the drawing has no third-party material. It is original work of the author, all
rights reserved; the repository has no `LICENSE` file, so no reuse licence is granted.

## Decision

The generated drawing is the sample. `agent/tools/make_sample_dxf.py` writes `agent/tools/sample/warehouse.dxf` with ezdxf,
and the file is committed. The drawing is original work of the author, all rights reserved, and no internet DXF is downloaded. This is a deviation from SPEC §4.5, and this ADR is its record. The changes that come with it are:

- The committed file is a generated ASCII DXF (R2010), not a binary. A `.gitignore` exception keeps it in git.
- `ezdxf==1.4.*` is a dev dependency (MIT licence). The lock adds its dependencies `fonttools`, `numpy` and `pyparsing`.
  The generator is not part of the console or the agent runtime.
- The `make check-py` and `make lint` targets run `mypy --strict` on `tools/` as well as `src/`, so the generator is type
  checked.
- The generator uses ezdxf's fixed-metadata switch, `ezdxf.options.write_fixed_meta_data_for_testing`. The switch is set
  in memory only while the drawing is built and saved, and it is restored afterwards. Without it, the creation time, the
  save time and the GUIDs would change on every run.
- The DXF classes are registered in sorted order before the save. Without this, ezdxf writes the CLASSES section in an
  order that depends on the Python hash seed (see `docs/JOURNAL.md`, 2026-11-03).

## Alternatives considered

| Option                                               | Pros                                        | Cons                                                                                   | Why not                                                                 |
| ---------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Download a free-licence DXF from the internet (SPEC) | A real floor plan; matches the spec wording | Licence review, provenance and third-party content to check, before the deadline       | Time and licence risk for a demo fixture; kept as a possible later step |
| Draw the sample by hand in a CAD tool and commit it  | Full control of the drawing                 | The CAD tool's file and licence terms, and no way to regenerate or test the drawing    | Not reproducible; no test can pin its content                           |
| Generate the file at test time, nothing committed    | No binary in git                            | The demo and the end-to-end tests need the file on disk; a generator run on each test  | Slower, and the drawing would not be reviewable as a file               |
| Keep ezdxf's default output and compare sorted lines | No ezdxf option, no sort call               | The comparison hides real byte changes; the order still changes between runs           | A check that cannot see a change is not a determinism check             |
| Pin `PYTHONHASHSEED` for the generator               | One line in the Makefile                    | Only works if the generator runs under that variable; users who run it directly differ | The fix belongs in the generator, not in the environment                |

## Consequences

- SPEC §4.5 is not met literally: the sample is not a downloaded drawing. The report and the README must say so. The
  console's import path is still exercised by a real DXF file, with TEXT, MTEXT, arcs, blocks and polylines.
- The repository still has no `LICENSE` file. The sample grants no reuse licence until a `LICENSE` file is added, which must happen before the
  repository is shared publicly.
- Changing the generator changes the committed file, and the test fails until both are updated together. This is intended.
- The `ezdxf` options switch is a test-only switch of ezdxf. It is set and restored inside the generator; a future ezdxf
  release could rename it, and the test that compares bytes would then fail.
- ezdxf is in the `dev` group of `agent/pyproject.toml`, so the runtime dependency set of the agent does not change.
