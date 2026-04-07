(function($) {

    var Defaults = $.fn.select2.amd.require('select2/defaults');

    $.extend(Defaults.defaults, {
        searchInputPlaceholder: '',
        searchInputCssClass: '',
    });

    var SearchDropdown = $.fn.select2.amd.require('select2/dropdown/search');

    var _renderSearchDropdown = SearchDropdown.prototype.render;

    SearchDropdown.prototype.render = function(decorated) {

        // invoke parent method
        var $rendered = _renderSearchDropdown.apply(this, Array.prototype.slice.apply(arguments));

        this.$search.attr('placeholder', this.options.get('searchInputPlaceholder'));
        this.$search.addClass(this.options.get('searchInputCssClass'));

        return $rendered;
    };

    // Mobile: prevent virtual keyboard from auto-popping when select2 opens.
    // Sets the search field to readOnly momentarily so the browser won't summon
    // the IME. After 300ms readOnly is lifted — user can still tap the field to
    // type a search query manually.
    $(document).on('select2:open', function () {
        if (!/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) return;
        var searchField = document.querySelector('.select2-container--open .select2-search__field');
        if (searchField) {
            searchField.readOnly = true;
            setTimeout(function () { searchField.readOnly = false; }, 300);
        }
    });

})(window.jQuery);
