-- Retire the read-only widget credentials and index the native pairing lookups.
update public.inori_documents
set data = data - 'widgetHash' - 'widgetDetails', revision = revision + 1
where data ?| array['widgetHash', 'widgetDetails'];

drop index if exists public.inori_widget_hash;

create unique index inori_native_widget_hash
  on public.inori_documents ((data->>'nativeWidgetHash'))
  where data->>'nativeWidgetHash' is not null;

create unique index inori_native_pair_hash
  on public.inori_documents ((data->>'nativePairHash'))
  where data->>'nativePairHash' is not null;
