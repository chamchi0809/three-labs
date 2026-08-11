# three-labs

three.js/WebGPU 렌더링 실험 모노레포. 프로젝트 하나 = 최상위 디렉토리 하나 = `lib/` + `demo/`.

- 하위 호환 유지하지 말 것.
- 현재 요구사항을 완전히 만족하는 가장 단순한 구현을 고를 것.
- 직접 구현보다 검증된 라이브러리를 우선할 것.

## 새 라이브러리 추가

`sdfgi/`를 그대로 베끼는 게 제일 빠름 (`rc-25d/`는 dist 빌드가 껴 있어서 더 복잡함).

```
<name>/
  tsconfig.base.json   # sdfgi/ 것 복사, 필요한 것만 수정
  lib/                 # package.json, tsconfig.json, src/index.ts
  demo/                # package.json, tsconfig.json, index.html, vite.config.ts, src/main.ts
```

`pnpm-workspace.yaml`에 `<name>/*` 한 줄, 루트 `package.json`에 `dev:<name>` 스크립트 한 줄 추가.

규칙:
- 패키지명은 워크스페이스 전역에서 유일해야 함 (`demo` 금지 → `<name>-demo`).
- 데모는 `"<lib-name>": "workspace:*"` 로 라이브러리를 참조.
- 각 패키지 `tsconfig.json`은 `../tsconfig.base.json`을 extends.
- 공용 툴체인(`three`, `@types/three`, `@webgpu/types`, `typescript`, `vite`, `@types/node`)은 루트 devDependencies 하나만. 패키지에서 재선언 금지 — 위로 올라가며 resolve됨.
- lib은 `three`를 `peerDependencies`로만 선언. 패키지 자기 `dependencies`는 워크스페이스 링크(`workspace:*`) 정도만 남김.

라이브러리 배포 방식은 둘 중 하나:
- **소스 export** (기본, `sdfgi/lib`): `main`/`exports` 가 `./src/index.ts`, import에 `.ts` 확장자. 빌드 스텝 없음.
- **dist 빌드** (`rc-25d/lib`): `tsconfig.build.json` + `build` 스크립트, import에 `.js` 확장자. npm 퍼블리시할 때만.

## 검증

GPU 없이 돌릴 수 있는 것만 테스트함. 셰이더 밖 산술/부기 로직(캐스케이드 레이아웃, 스크롤 리전 등)은 조용히 틀리므로 체크를 남길 것.

- `<pkg>/*.check.ts` 또는 `src/*.test.ts` — `node --experimental-strip-types`로 직접 실행, 프레임워크 없음.
- `package.json`에 `check` 또는 `test` 스크립트로 물려두면 `pnpm check` / `pnpm test`가 알아서 잡음.
- 루트에서 `pnpm typecheck` / `pnpm build` 통과 확인.
