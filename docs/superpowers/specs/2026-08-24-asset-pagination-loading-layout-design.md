# Asset pagination loading layout design

## Problem

When Asset Browser loads an adjacent page during fast wheel scrolling or date-rail dragging, it renders a `Skeleton` after `AssetGallery`. Because the gallery and skeleton share a column flex layout, the temporary skeleton consumes about one control row of height. The gallery viewport therefore shrinks while the request is pending and expands when it finishes, producing the transient gray band above the status bar.

## Design

Keep the gallery viewport stable while adjacent pages load:

- Remove only the `nextLoading` and `prevLoading` pagination skeletons below `AssetGallery`.
- Continue reporting pagination activity through `AssetBrowserStatus.loading`; the existing status bar remains the loading indicator.
- Keep the first-page skeleton because no gallery content exists yet.
- Keep pagination errors and retry controls because they require an explicit user action.
- Do not alter pagination, virtualization, date-rail behavior, or page size.

## Verification

Add an `AssetBrowser` regression test that holds an adjacent-page request open and proves:

- loading is still reported through `onStatusChange`;
- the existing gallery remains rendered;
- no adjacent-page loading skeleton is inserted into the layout.

Run the focused `AssetBrowser` test file. Since this is a localized rendering change, broader suites and a production installer build are unnecessary unless the focused check exposes a wider risk.
