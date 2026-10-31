# Person hero

The Person page shows age, initials, and a photo thumbhash in one portrait.
A living person with a `birth_date` shows that date and a whole-year age.
A `death_date` shows the death fact and does not show a living age, even when the death text is not a calendar date.
Birth, death, and birthplace stay visible. A blank fact is left out.
A valid `YYYY-MM-DD` date is shown in English medium form, such as `Apr 12, 1980`. Any other text is shown unchanged, and no age is invented from it.
Age uses this TV's local calendar date. The client does not turn a date-only string into a UTC instant.
February 29 is a birthday only in a Gregorian leap year. In any other year the birthday is reached on March 1.
An age is absent when the birth date is still in the future. A birthday today is included. The count does not move until the page is shown again; this slice does not poll.

A portrait with no usable photo shows the first grapheme of each of the first two words in the name, uppercased for English, or `?` when the name is empty.
A photo draws its `photo_thumbhash` underneath until the image loads, then fades the photo in over 120 ms.
Reduced motion shows the photo immediately.
A failed photo keeps the thumbhash when it decoded, and does not replace that preview with initials.
The photo request uses the signed URL only: no app credential is added, and the image sends no referrer.
Back and an authority change cancel a photo that has not arrived, so a late response cannot paint on the next screen.
Moving focus does not fetch the person, the filmography, or the photo again.

The portrait is the tvOS person size, 300 by 450, with a 12 px corner and 20 px metadata capsules.
The page keeps the Skyline safe area already used by browse.
There is no new cache.
One portrait decodes its own thumbhash when it is drawn, rejecting inputs longer than 44 Base64 characters before decoding.
`unicode-segmenter` provides Unicode grapheme boundaries on Chromium 76, which has no `Intl.Segmenter`, so initials preserve Hangul syllables and Indic conjuncts as well as emoji.
The packaged third-party notices retain the ThumbHash and segmentation licenses; the ThumbHash permission notice is also preserved in the JavaScript bundle.

Primary sources are Apple `PersonDetailView.swift` at `f33479404712737499b22365430db1885cf6c6ab`, the same hero at `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940` (two commits ahead, with no hero change), server `cc8514943289045e7b9f7ac8d36d4968bfe93926` where OpenAPI declares `photo_thumbhash`, and Skyline guide SHA-256 `2d42d292e01ab6ee539278b63c286756fc432edf876a9286a33c9e853672cac2`.

This does not complete Person parity or issue 28.
Metadata refresh polling and further person filters remain separate.
[Filmography](person-filmography.md) is unchanged by this slice.
Synthetic desktop tests and captures do not prove a live server, Chromium 76, AVPlay, a signed package, the emulator, or a television.
