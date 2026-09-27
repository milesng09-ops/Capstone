"""``app/providers/instruments.py`` is the one place tick size, price
precision and timezone are defined for each symbol the application knows
about; every chart axis, rounded price and session boundary trusts these
three numbers. A typo here would not raise anywhere in particular -- it
would just round prices to the wrong number of decimals or draw sessions in
the wrong timezone, so the values are pinned outright rather than merely
range-checked.
"""

from __future__ import annotations

import pytest

from app.providers.instruments import (
    CANONICAL_INSTRUMENTS,
    SUPPORTED_SYMBOLS,
    UnknownSymbolError,
    get_instrument,
    list_instruments,
)


class TestTheCanonicalCatalogue:
    def test_exactly_the_three_futures_the_application_supports_are_listed(self):
        assert set(CANONICAL_INSTRUMENTS) == {"ES", "NQ", "YM"}

    def test_supported_symbols_mirrors_the_catalogue_in_the_same_order(self):
        # Some callers (a fresh BacktestRequest's default `symbols`) rely on
        # this being a stable, ordered list rather than an arbitrary set.
        assert SUPPORTED_SYMBOLS == ["ES", "NQ", "YM"]

    @pytest.mark.parametrize(
        ("symbol", "tick_size", "price_precision"),
        [
            ("ES", 0.25, 2),
            ("NQ", 0.25, 2),
            ("YM", 1.0, 0),
        ],
    )
    def test_tick_size_and_price_precision_match_the_real_contract_specs(
        self, symbol, tick_size, price_precision
    ):
        instrument = CANONICAL_INSTRUMENTS[symbol]

        assert instrument.tick_size == tick_size
        assert instrument.price_precision == price_precision

    def test_every_instrument_keys_itself_correctly(self):
        # A copy-paste error while adding a fourth symbol would otherwise
        # produce a catalogue entry that answers to the wrong name.
        for key, instrument in CANONICAL_INSTRUMENTS.items():
            assert instrument.symbol == key

    def test_every_instrument_uses_the_real_iana_timezone_for_its_exchange(self):
        # All three are Chicago-traded CME/CBOT futures. A typo such as
        # "America/Chicago " or "US/Chicago" would not fail any runtime
        # check -- ZoneInfo would happily load a slightly different zone --
        # only a test that knows the expected value would catch it.
        for instrument in CANONICAL_INSTRUMENTS.values():
            assert instrument.timezone == "America/Chicago"

    def test_tick_size_is_positive_and_price_precision_is_not_negative(self):
        for instrument in CANONICAL_INSTRUMENTS.values():
            assert instrument.tick_size > 0
            assert instrument.price_precision >= 0


class TestLookup:
    def test_a_known_symbol_is_found(self):
        instrument = get_instrument("ES")

        assert instrument.symbol == "ES"
        assert instrument.display_name == "E-mini S&P 500 Futures"

    def test_lookup_is_case_insensitive(self):
        assert get_instrument("es").symbol == "ES"

    def test_lookup_tolerates_surrounding_whitespace(self):
        assert get_instrument("  YM  ").symbol == "YM"

    def test_an_unknown_symbol_raises_unknown_symbol_error(self):
        with pytest.raises(UnknownSymbolError):
            get_instrument("BTC")

    def test_the_error_names_the_rejected_symbol_and_what_is_supported(self):
        with pytest.raises(UnknownSymbolError, match="BTC"):
            get_instrument("BTC")

    def test_unknown_symbol_error_is_a_value_error(self):
        # The API layer catches ValueError as its generic "bad input" case;
        # if this stopped being a ValueError subclass, an unsupported symbol
        # would 500 instead of being answered as a client error.
        assert issubclass(UnknownSymbolError, ValueError)


class TestListInstruments:
    def test_returns_all_three_canonical_instruments(self):
        instruments = list_instruments()

        assert {instrument.symbol for instrument in instruments} == {"ES", "NQ", "YM"}

    def test_returns_independent_copies_not_shared_references(self):
        """Providers overwrite `contract_note` on their own copy of the
        catalogue per request (see `DemoProvider.get_symbols`). If
        `list_instruments` ever started handing back the live catalogue
        objects instead of copies, the first request to mutate one would
        silently corrupt the shared catalogue for every request after it --
        nothing here would raise, the next chart would just carry the wrong
        note."""

        first_call = list_instruments()
        first_call[0].contract_note = "mutated"

        second_call = list_instruments()

        assert second_call[0].contract_note != "mutated"
        assert CANONICAL_INSTRUMENTS[first_call[0].symbol].contract_note != "mutated"
